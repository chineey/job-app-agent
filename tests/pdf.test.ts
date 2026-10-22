import { describe, it, expect } from 'vitest';
import { generateResumePdfBuffer } from '../lib/pdf/Resume';
import { MasterFacts, ResumeJson } from '../lib/schemas';

describe('PDF Resume Generator', () => {
  const sampleFacts: MasterFacts = {
    identity: {
      name: 'Jordan Lee',
      email: 'jordan@example.com',
      phone: '+1-555-0144',
      location: 'New York, NY',
      links: {
        github: 'https://github.com/jordanlee',
        linkedin: 'https://linkedin.com/in/jordanlee',
        portfolio: 'https://jordanlee.dev',
      },
    },
    years_experience: 4,
    open_to_relocation: false,
    education: [
      {
        id: 'edu-1',
        school: 'Columbia University',
        degree: 'B.S. in Computer Engineering',
        dates: '2016 - 2020',
      },
    ],
    certs: [
      {
        id: 'cert-1',
        name: 'CKA: Certified Kubernetes Administrator',
        issuer: 'CNCF',
      },
    ],
    experience: [
      {
        id: 'exp-1',
        org: 'Apex Tech',
        title: 'Backend Engineer',
        dates: '2020 - Present',
        bullets: [
          { id: 'b-1', text: 'Built real-time messaging pipeline using Kafka and Go.' },
          { id: 'b-2', text: 'Reduced p95 latency by 30% through connection pooling.' },
        ],
      },
    ],
    projects: [
      {
        id: 'proj-1',
        name: 'Distributed Lock Service',
        one_liner: 'Fast distributed mutual exclusion service built with Raft consensus',
        stack: ['Go', 'Raft', 'gRPC'],
        email_note: 'Highlights distributed systems expertise.',
        bullets: [
          { id: 'pb-1', text: 'Handled 15k lock acquisitions per second with sub-10ms latency.' },
        ],
      },
    ],
    skills: {
      strong: ['Go', 'TypeScript', 'PostgreSQL', 'Kafka'],
      working: ['Docker', 'Kubernetes', 'Redis'],
      known_gaps: ['Frontend UI frameworks'],
    },
    fixed_priority: ['proj-1'],
    gap_framing: 'I ramp up on new backend stacks quickly by reading specs and source code.',
  };

  const sampleTailored: ResumeJson = {
    summary_line: 'Backend engineer specializing in distributed systems, high-throughput streaming, and Go microservices.',
    project_ids: ['proj-1'],
    bullet_ids: ['b-1', 'pb-1'],
    skill_order: ['Go', 'Kafka', 'PostgreSQL', 'TypeScript', 'Docker'],
  };

  it('renders a valid PDF buffer starting with standard %PDF- header', async () => {
    const pdfBuffer = await generateResumePdfBuffer(sampleFacts, sampleTailored);

    expect(pdfBuffer).toBeDefined();
    expect(pdfBuffer.length).toBeGreaterThan(1000);

    const header = pdfBuffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });
});
