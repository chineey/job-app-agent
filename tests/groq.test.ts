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

  it('forwards image attachments as Groq image_url parts in extractJobDetails', async () => {
    const fetchSpy = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u === 'https://example.com/flyer.png') {
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  transcribed_text: 'Apply to jobs@acme.com',
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

    const chatCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/chat/completions'));
    expect(chatCall).toBeDefined();
    const body = JSON.parse(chatCall![1]?.body as string);
    const userContent = body.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(
      userContent.some(
        (p: { type: string; image_url?: { url: string } }) =>
          p.type === 'image_url' && p.image_url?.url.startsWith('data:image/png;base64,')
      )
    ).toBe(true);
  });
});
