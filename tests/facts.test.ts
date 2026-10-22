import { describe, it, expect } from 'vitest';
import {
  validateMasterFacts,
  mergeWithActiveFacts,
  computeFactsDiff,
} from '../lib/facts';
import { MasterFacts } from '../lib/schemas';

describe('Master Facts Validation & Diffing', () => {
  const sampleFacts: MasterFacts = {
    identity: {
      name: 'Alex Rivera',
      email: 'alex@example.com',
      phone: '+1-555-0199',
      location: 'San Francisco, CA',
      links: {
        github: 'https://github.com/alexrivera',
        linkedin: 'https://linkedin.com/in/alexrivera',
        portfolio: 'https://alexrivera.dev',
      },
    },
    years_experience: 5,
    open_to_relocation: true,
    education: [
      {
        id: 'edu-1',
        school: 'University of California, Berkeley',
        degree: 'B.S. in Computer Science',
        dates: '2016 - 2020',
      },
    ],
    certs: [
      {
        id: 'cert-1',
        name: 'AWS Certified Solutions Architect',
        issuer: 'Amazon Web Services',
      },
    ],
    experience: [
      {
        id: 'exp-1',
        org: 'CloudScale Inc.',
        title: 'Senior Backend Engineer',
        dates: '2022 - Present',
        bullets: [
          { id: 'b-1', text: 'Architected distributed event pipeline handling 20k events/sec.' },
          { id: 'b-2', text: 'Optimized Postgres query performance, reducing P99 latency by 45%.' },
        ],
      },
    ],
    projects: [
      {
        id: 'p-1',
        name: 'Distributed Queue System',
        one_liner: 'High-throughput in-memory queue with Raft consensus in Go',
        stack: ['Go', 'Raft', 'gRPC'],
        email_note: 'Demonstrates deep systems engineering & consensus experience.',
        bullets: [
          { id: 'pb-1', text: 'Implemented leader election and log replication with sub-5ms heartbeat.' },
        ],
      },
    ],
    skills: {
      strong: ['TypeScript', 'Go', 'PostgreSQL', 'Docker'],
      working: ['React', 'Python', 'Redis'],
      known_gaps: ['Kubernetes cluster administration'],
    },
    fixed_priority: ['p-1'],
    gap_framing: 'I learn systems software rapidly by studying RFCs and implementing core primitives.',
  };

  it('validates a complete, conforming Master Facts object', () => {
    const result = validateMasterFacts(sampleFacts);
    expect(result.success).toBe(true);
  });

  it('fails validation when mandatory fields are missing or invalid', () => {
    const invalid = { ...sampleFacts, identity: { ...sampleFacts.identity, email: 'not-an-email' } };
    const result = validateMasterFacts(invalid);
    expect(result.success).toBe(false);
  });

  it('preserves non-resume fields during mergeWithActiveFacts', () => {
    const newResumeExtraction: Partial<MasterFacts> = {
      identity: {
        name: 'Alex Rivera',
        email: 'alex@example.com',
        phone: '+1-555-0199',
        location: 'San Francisco, CA',
        links: { github: '', linkedin: '', portfolio: '' },
      },
      projects: sampleFacts.projects,
      experience: sampleFacts.experience,
      skills: { strong: ['TypeScript'], working: ['Go'], known_gaps: [] },
    };

    const merged = mergeWithActiveFacts(newResumeExtraction, sampleFacts);
    expect(merged.years_experience).toBe(5);
    expect(merged.open_to_relocation).toBe(true);
    expect(merged.gap_framing).toBe(sampleFacts.gap_framing);
    expect(merged.fixed_priority).toEqual(['p-1']);
  });

  it('computes accurate diff when a project or bullet is added', () => {
    const updatedFacts: MasterFacts = {
      ...sampleFacts,
      projects: [
        ...sampleFacts.projects,
        {
          id: 'p-2',
          name: 'AI Agent Sandbox',
          one_liner: 'Autonomous browser-controlled testing agent',
          stack: ['TypeScript', 'Puppeteer'],
          email_note: '',
          bullets: [{ id: 'pb-2', text: 'Automated E2E multi-tab workflow tests.' }],
        },
      ],
    };

    const diff = computeFactsDiff(sampleFacts, updatedFacts);
    expect(diff.has_changes).toBe(true);
    expect(diff.added_projects).toContain('AI Agent Sandbox');
    expect(diff.added_bullets).toContain('Automated E2E multi-tab workflow tests.');
    expect(diff.removed_projects).toHaveLength(0);
  });
});
