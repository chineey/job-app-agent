import { z } from 'zod';

// ==========================================
// 1. Master Facts Schemas (Section 9)
// ==========================================

export const IdentitySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Valid email is required'),
  phone: z.string().default(''),
  location: z.string().default(''),
  links: z.object({
    github: z.string().default(''),
    linkedin: z.string().default(''),
    portfolio: z.string().default(''),
  }).default({ github: '', linkedin: '', portfolio: '' }),
});

export const EducationItemSchema = z.object({
  id: z.string(),
  school: z.string(),
  degree: z.string(),
  dates: z.string(),
});

export const CertItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  issuer: z.string(),
});

export const BulletItemSchema = z.object({
  id: z.string(),
  text: z.string(),
});

export const ExperienceItemSchema = z.object({
  id: z.string(),
  org: z.string(),
  title: z.string(),
  dates: z.string(),
  bullets: z.array(BulletItemSchema).default([]),
});

export const ProjectItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  one_liner: z.string(),
  stack: z.array(z.string()).default([]),
  email_note: z.string().default(''),
  bullets: z.array(BulletItemSchema).default([]),
});

export const SkillsSchema = z.object({
  strong: z.array(z.string()).default([]),
  working: z.array(z.string()).default([]),
  known_gaps: z.array(z.string()).default([]),
});

export const MasterFactsSchema = z.object({
  identity: IdentitySchema,
  years_experience: z.number().int().min(0, 'Years of experience must be non-negative'),
  open_to_relocation: z.boolean().default(false),
  education: z.array(EducationItemSchema).default([]),
  certs: z.array(CertItemSchema).default([]),
  experience: z.array(ExperienceItemSchema).default([]),
  projects: z.array(ProjectItemSchema).default([]),
  skills: SkillsSchema,
  fixed_priority: z.array(z.string()).default([]),
  gap_framing: z.string().default(''),
});

export type MasterFacts = z.infer<typeof MasterFactsSchema>;
export type BulletItem = z.infer<typeof BulletItemSchema>;
export type ProjectItem = z.infer<typeof ProjectItemSchema>;
export type ExperienceItem = z.infer<typeof ExperienceItemSchema>;

// ==========================================
// 2. Gemini Multimodal Extract Schema (Section 7.2)
// Note: Model does NOT return contact_email; extracted by regex in code.
// ==========================================

export const JobExtractSchema = z.object({
  transcribed_text: z.string().default(''),
  is_job: z.boolean(),
  is_software_role: z.boolean(),
  role: z.string().nullable().default(null),
  company: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  remote: z.boolean().nullable().default(null),
  relocation_required: z.boolean().nullable().default(null),
  visa_sponsorship: z.enum(['yes', 'no', 'unknown']).default('unknown'),
  min_years: z.number().int().nullable().default(null),
  salary: z.string().nullable().default(null),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD or null').nullable().default(null),
  requirements: z.array(z.string()).default([]),
  apply_method: z.enum(['email', 'form', 'dm', 'link', 'unknown']).default('unknown'),
  scam_risk: z.enum(['low', 'medium', 'high']).default('low'),
  scam_reasons: z.array(z.string()).default([]),
});

export type JobExtract = z.infer<typeof JobExtractSchema>;

// ==========================================
// 3. Gemini Match Schema (Section 7.5)
// ==========================================

export const JobMatchSchema = z.object({
  fit_score: z.number().int().min(0).max(100),
  gaps: z.array(z.string()).default([]),
  years_gap: z.boolean().default(false),
  explanation: z.string().default(''),
});

export type JobMatch = z.infer<typeof JobMatchSchema>;

// ==========================================
// 4. Gemini Tailor Schemas (Section 7.6)
// ==========================================

export const ResumeJsonSchema = z.object({
  summary_line: z.string().min(10, 'Summary line must be meaningful'),
  project_ids: z.array(z.string()).min(1, 'Select at least one project'),
  bullet_ids: z.array(z.string()).min(1, 'Select relevant bullet IDs from bank'),
  skill_order: z.array(z.string()).default([]),
});

export const EmailSlotsSchema = z.object({
  subject: z.string().min(3),
  opening_line: z.string().min(10),
  project_fit_sentences: z.string().min(10),
  gap_sentence: z.string().default(''),
});

export const TailorOutputSchema = z.object({
  resume_json: ResumeJsonSchema.nullable(), // null in uploaded mode
  email_slots: EmailSlotsSchema,
  cover_note: z.string().nullable().default(null), // for link route
});

export type ResumeJson = z.infer<typeof ResumeJsonSchema>;
export type EmailSlots = z.infer<typeof EmailSlotsSchema>;
export type TailorOutput = z.infer<typeof TailorOutputSchema>;

// ==========================================
// 5. Gemini Verify Schema (Section 7.7)
// ==========================================

export const VerifyOutputSchema = z.object({
  supported: z.boolean(),
  unsupported_claims: z.array(z.string()).default([]),
});

export type VerifyOutput = z.infer<typeof VerifyOutputSchema>;

// ==========================================
// 6. Recruiter Reply Classification & Draft Schema (Dev B, Section 7.10)
// ==========================================

export const ReplyClassificationSchema = z.object({
  category: z.enum(['interview', 'assessment', 'question', 'rejection', 'auto', 'other']),
  summary: z.string().default(''),
  suggested_action: z.string().default(''),
});

export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>;

export const ReplyDraftSchema = z.object({
  reply_body: z.string().min(10, 'Reply body must be substantial'),
  availability_placeholder_used: z.boolean().default(false),
});

export type ReplyDraft = z.infer<typeof ReplyDraftSchema>;
