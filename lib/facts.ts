import { MasterFacts, MasterFactsSchema } from './schemas';

export interface FactsDiffSummary {
  added_projects: string[];
  removed_projects: string[];
  added_bullets: string[];
  removed_bullets: string[];
  added_certs: string[];
  removed_certs: string[];
  experience_changes: string[];
  education_changes: string[];
  has_changes: boolean;
}

/**
 * Validates raw JSON object against MasterFactsSchema.
 */
export function validateMasterFacts(data: unknown): { success: true; data: MasterFacts } | { success: false; errors: string[] } {
  const result = MasterFactsSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
  };
}

/**
 * Carries over fields that a resume cannot infer (years, relocation, gap framing, etc.)
 * from the previous active facts into newly parsed facts.
 */
export function mergeWithActiveFacts(newFacts: Partial<MasterFacts>, activeFacts?: MasterFacts | null): MasterFacts {
  const fallback: MasterFacts = {
    identity: {
      name: newFacts.identity?.name || '',
      email: newFacts.identity?.email || '',
      phone: newFacts.identity?.phone || '',
      location: newFacts.identity?.location || '',
      links: {
        github: newFacts.identity?.links?.github || '',
        linkedin: newFacts.identity?.links?.linkedin || '',
        portfolio: newFacts.identity?.links?.portfolio || '',
      },
    },
    years_experience: activeFacts ? activeFacts.years_experience : (newFacts.years_experience ?? 0),
    open_to_relocation: activeFacts ? activeFacts.open_to_relocation : (newFacts.open_to_relocation ?? false),
    education: newFacts.education || [],
    certs: newFacts.certs || [],
    experience: newFacts.experience || [],
    projects: newFacts.projects || [],
    skills: {
      strong: newFacts.skills?.strong || [],
      working: newFacts.skills?.working || [],
      known_gaps: activeFacts ? activeFacts.skills.known_gaps : (newFacts.skills?.known_gaps || []),
    },
    fixed_priority: activeFacts ? activeFacts.fixed_priority : (newFacts.fixed_priority || []),
    gap_framing: activeFacts ? activeFacts.gap_framing : (newFacts.gap_framing || ''),
  };

  return fallback;
}

/**
 * Calculates a structured human-readable diff between an active facts version
 * and a newly proposed facts version.
 */
export function computeFactsDiff(active: MasterFacts | null | undefined, proposed: MasterFacts): FactsDiffSummary {
  if (!active) {
    return {
      added_projects: proposed.projects.map((p) => p.name),
      removed_projects: [],
      added_bullets: proposed.projects.flatMap((p) => p.bullets.map((b) => b.text)),
      removed_bullets: [],
      added_certs: proposed.certs.map((c) => c.name),
      removed_certs: [],
      experience_changes: proposed.experience.map((e) => `${e.title} at ${e.org}`),
      education_changes: proposed.education.map((ed) => `${ed.degree} from ${ed.school}`),
      has_changes: true,
    };
  }

  const activeProjectNames = new Set(active.projects.map((p) => p.name.toLowerCase()));
  const proposedProjectNames = new Set(proposed.projects.map((p) => p.name.toLowerCase()));

  const added_projects = proposed.projects.filter((p) => !activeProjectNames.has(p.name.toLowerCase())).map((p) => p.name);
  const removed_projects = active.projects.filter((p) => !proposedProjectNames.has(p.name.toLowerCase())).map((p) => p.name);

  // Bullets diff
  const activeBullets = new Set(
    [...active.experience.flatMap((e) => e.bullets), ...active.projects.flatMap((p) => p.bullets)].map((b) => b.text.trim())
  );
  const proposedBullets = new Set(
    [...proposed.experience.flatMap((e) => e.bullets), ...proposed.projects.flatMap((p) => p.bullets)].map((b) => b.text.trim())
  );

  const added_bullets = [...proposedBullets].filter((b) => !activeBullets.has(b));
  const removed_bullets = [...activeBullets].filter((b) => !proposedBullets.has(b));

  // Certs diff
  const activeCerts = new Set(active.certs.map((c) => c.name.toLowerCase()));
  const proposedCerts = new Set(proposed.certs.map((c) => c.name.toLowerCase()));

  const added_certs = proposed.certs.filter((c) => !activeCerts.has(c.name.toLowerCase())).map((c) => c.name);
  const removed_certs = active.certs.filter((c) => !proposedCerts.has(c.name.toLowerCase())).map((c) => c.name);

  // Experience changes
  const experience_changes: string[] = [];
  if (active.experience.length !== proposed.experience.length) {
    experience_changes.push(`Roles count changed: ${active.experience.length} -> ${proposed.experience.length}`);
  }

  // Education changes
  const education_changes: string[] = [];
  if (active.education.length !== proposed.education.length) {
    education_changes.push(`Education entries changed: ${active.education.length} -> ${proposed.education.length}`);
  }

  const has_changes =
    added_projects.length > 0 ||
    removed_projects.length > 0 ||
    added_bullets.length > 0 ||
    removed_bullets.length > 0 ||
    added_certs.length > 0 ||
    removed_certs.length > 0 ||
    experience_changes.length > 0 ||
    education_changes.length > 0;

  return {
    added_projects,
    removed_projects,
    added_bullets,
    removed_bullets,
    added_certs,
    removed_certs,
    experience_changes,
    education_changes,
    has_changes,
  };
}
