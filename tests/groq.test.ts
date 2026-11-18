import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractJobDetails, callLlmWithRetry } from '../lib/groq';
import { z } from 'zod';

describe('Groq LLM Integration with Gemini Fallback (lib/groq.ts)', () => {
  const originalFetch = global.fetch;
  const originalGroqKey = process.env.GROQ_API_KEY;
  const originalGroqModel = process.env.GROQ_MODEL;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalGeminiBase = process.env.GEMINI_API_BASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GROQ_API_KEY = 'gsk-test-key';
    process.env.GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_BASE_URL;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroqKey;

    if (originalGroqModel === undefined) delete process.env.GROQ_MODEL;
    else process.env.GROQ_MODEL = originalGroqModel;

    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;

    if (originalGeminiBase === undefined) delete process.env.GEMINI_API_BASE_URL;
    else process.env.GEMINI_API_BASE_URL = originalGeminiBase;
  });

  it('calls Groq /chat/completions with Bearer token and strips markdown JSON fences', async () => {
    const schema = z.object({ ok: z.boolean(), count: z.number() });
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '```json\n{"ok": true, "count": 2}\n```',
              },
            },
          ],
        }),
        { status: 200 }
      );
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await callLlmWithRetry('Return ok', [], schema);

    expect(result).toEqual({ ok: true, count: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer gsk-test-key');
  });

  it('retries without response_format when Groq returns 400', async () => {
    const schema = z.object({ status: z.string() });
    const fetchSpy = vi
      .fn<(_url: string | URL | Request, _init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('response_format unsupported', { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"status":"ready"}' } }],
          }),
          { status: 200 }
        )
      );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await callLlmWithRetry('Return status', [], schema);
    expect(result).toEqual({ status: 'ready' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const secondBody = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
    expect(firstBody.response_format).toEqual({ type: 'json_object' });
    expect(secondBody.response_format).toBeUndefined();
  });

  it('skips post image URLs and sends text-only string content in extractJobDetails', async () => {
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  transcribed_text: '',
                  is_job: true,
                  is_software_role: true,
                  role: 'Backend Engineer',
                  company: 'Acme',
                  location: 'Remote',
                  remote: true,
                  relocation_required: false,
                  visa_sponsorship: 'unknown',
                  min_years: 2,
                  salary: null,
                  deadline: null,
                  requirements: ['TypeScript'],
                  apply_method: 'email',
                  scam_risk: 'low',
                  scam_reasons: [],
                }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const extract = await extractJobDetails('Hiring!', ['https://example.com/flyer.png']);
    expect(extract.is_job).toBe(true);
    expect(extract.company).toBe('Acme');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(typeof body.messages[1].content).toBe('string');
  });

  it('falls back to Gemini when all Groq models fail', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test-key';
    const schema = z.object({ ok: z.boolean(), source: z.string() });
    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.startsWith('https://api.groq.com/')) {
        return new Response('Groq rate limit exceeded', { status: 429 });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"ok": true, "source": "gemini"}' }],
              },
            },
          ],
        }),
        { status: 200 }
      );
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await callLlmWithRetry('Return ok', [], schema);
    expect(result).toEqual({ ok: true, source: 'gemini' });
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('generativelanguage.googleapis.com'))).toBe(true);
  });
});
