import React from 'react';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  pdf,
} from '@react-pdf/renderer';
import { MasterFacts, ResumeJson } from '../schemas';

const styles = StyleSheet.create({
  page: {
    paddingTop: 28,
    paddingBottom: 28,
    paddingHorizontal: 36,
    fontFamily: 'Helvetica',
    fontSize: 9.5,
    color: '#1a1a1a',
    lineHeight: 1.35,
  },
  header: {
    marginBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#2b2b2b',
    paddingBottom: 6,
  },
  name: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 3,
  },
  contactRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    fontSize: 8.5,
    color: '#333333',
  },
  sectionTitle: {
    fontSize: 10.5,
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    borderBottomWidth: 0.5,
    borderBottomColor: '#999999',
    marginTop: 7,
    marginBottom: 4,
    paddingBottom: 1,
  },
  summaryText: {
    fontSize: 9,
    color: '#222222',
    marginBottom: 4,
  },
  entryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 3,
  },
  org: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9.5,
  },
  role: {
    fontFamily: 'Helvetica-Oblique',
    fontSize: 9,
    color: '#333333',
  },
  date: {
    fontSize: 8.5,
    color: '#444444',
  },
  bulletRow: {
    flexDirection: 'row',
    marginTop: 1.5,
    paddingLeft: 4,
  },
  bulletDot: {
    width: 8,
    fontSize: 9,
  },
  bulletText: {
    flex: 1,
    fontSize: 8.8,
    color: '#222222',
  },
  skillsText: {
    fontSize: 8.8,
    color: '#222222',
    marginTop: 2,
  },
});

interface ResumeDocumentProps {
  facts: MasterFacts;
  tailored: ResumeJson;
}

export const ResumeDocument: React.FC<ResumeDocumentProps> = ({ facts, tailored }) => {
  const { identity, education, certs, experience, projects } = facts;

  // Selected bullet IDs set
  const selectedBulletIds = new Set(tailored.bullet_ids);

  // Projects ordered and filtered
  const orderedProjects = tailored.project_ids
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => p !== undefined);

  // Skills ordering
  const baseSkills = [...facts.skills.strong, ...facts.skills.working];
  const orderedSkills = [
    ...tailored.skill_order.filter((s) => baseSkills.includes(s)),
    ...baseSkills.filter((s) => !tailored.skill_order.includes(s)),
  ];

  return (
    <Document title={`${identity.name} - Resume`} author={identity.name}>
      <Page size="A4" style={styles.page}>
        {/* Header - LOCKED FIELDS */}
        <View style={styles.header}>
          <Text style={styles.name}>{identity.name}</Text>
          <View style={styles.contactRow}>
            {identity.email ? <Text>{identity.email}</Text> : null}
            {identity.phone ? <Text>• {identity.phone}</Text> : null}
            {identity.location ? <Text>• {identity.location}</Text> : null}
            {identity.links.github ? <Text>• GitHub: {identity.links.github}</Text> : null}
            {identity.links.linkedin ? <Text>• LinkedIn: {identity.links.linkedin}</Text> : null}
            {identity.links.portfolio ? <Text>• {identity.links.portfolio}</Text> : null}
          </View>
        </View>

        {/* Summary */}
        {tailored.summary_line ? (
          <View>
            <Text style={styles.sectionTitle}>Summary</Text>
            <Text style={styles.summaryText}>{tailored.summary_line}</Text>
          </View>
        ) : null}

        {/* Technical Skills */}
        <View>
          <Text style={styles.sectionTitle}>Technical Skills</Text>
          <Text style={styles.skillsText}>{orderedSkills.join(', ')}</Text>
        </View>

        {/* Experience - LOCKED ORG/TITLE/DATES, SELECTIVE BULLETS */}
        {experience.length > 0 && (
          <View>
            <Text style={styles.sectionTitle}>Experience</Text>
            {experience.map((exp) => {
              const activeBullets = exp.bullets.filter(
                (b) => selectedBulletIds.has(b.id) || exp.bullets.length === 1
              );
              return (
                <View key={exp.id} style={{ marginBottom: 4 }}>
                  <View style={styles.entryHeader}>
                    <Text style={styles.org}>{exp.org}</Text>
                    <Text style={styles.date}>{exp.dates}</Text>
                  </View>
                  <Text style={styles.role}>{exp.title}</Text>
                  {activeBullets.map((b) => (
                    <View key={b.id} style={styles.bulletRow}>
                      <Text style={styles.bulletDot}>•</Text>
                      <Text style={styles.bulletText}>{b.text}</Text>
                    </View>
                  ))}
                </View>
              );
            })}
          </View>
        )}

        {/* Featured Projects - TAILORED SELECTION */}
        {orderedProjects.length > 0 && (
          <View>
            <Text style={styles.sectionTitle}>Featured Projects</Text>
            {orderedProjects.map((proj) => {
              const activeBullets = proj.bullets.filter(
                (b) => selectedBulletIds.has(b.id) || proj.bullets.length === 1
              );
              return (
                <View key={proj.id} style={{ marginBottom: 4 }}>
                  <View style={styles.entryHeader}>
                    <Text style={styles.org}>{proj.name}</Text>
                    <Text style={styles.date}>{proj.stack.join(' | ')}</Text>
                  </View>
                  <Text style={styles.role}>{proj.one_liner}</Text>
                  {activeBullets.map((b) => (
                    <View key={b.id} style={styles.bulletRow}>
                      <Text style={styles.bulletDot}>•</Text>
                      <Text style={styles.bulletText}>{b.text}</Text>
                    </View>
                  ))}
                </View>
              );
            })}
          </View>
        )}

        {/* Education & Certs - LOCKED FIELDS */}
        {(education.length > 0 || certs.length > 0) && (
          <View>
            <Text style={styles.sectionTitle}>Education & Certifications</Text>
            {education.map((ed) => (
              <View key={ed.id} style={styles.entryHeader}>
                <Text style={styles.org}>{ed.degree} - {ed.school}</Text>
                <Text style={styles.date}>{ed.dates}</Text>
              </View>
            ))}
            {certs.map((c) => (
              <View key={c.id} style={styles.entryHeader}>
                <Text style={styles.role}>{c.name} ({c.issuer})</Text>
              </View>
            ))}
          </View>
        )}
      </Page>
    </Document>
  );
};

/**
 * Generates ATS-compliant PDF buffer for the tailored resume.
 */
export async function generateResumePdfBuffer(
  facts: MasterFacts,
  tailored: ResumeJson
): Promise<Buffer> {
  const doc = <ResumeDocument facts={facts} tailored={tailored} />;
  const asPdf = pdf(doc);
  const blob = await asPdf.toBlob();
  const arrayBuffer = await blob.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
