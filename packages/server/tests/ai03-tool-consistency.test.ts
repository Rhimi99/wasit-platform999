import { describe, it, expect } from 'vitest';
import { AGENT_CATALOGUE, COPILOT_CATALOGUE, allAgentSpecs } from '../src/modules/ai/catalogue.js';
import {
  UNBOUND_DECLARED_TOOLS,
  findTool,
  isRegisteredTool,
  registeredToolIds,
  toolGrantForAgent,
} from '../src/lib/ai/tool-registry.js';

/**
 * AI-03.3 (gap L-2) — declared-tool consistency.
 *
 * Every id an agent declares in `allowedTools` must be classified: either it is
 * a registered gateway tool, or it is listed in `UNBOUND_DECLARED_TOOLS`. This
 * spec derives the declared set from the catalogue itself (not a hand-kept copy)
 * so a new declaration cannot drift out of the list unnoticed, and it proves the
 * unbound ids stay inert (no handler, no grant) — listing them must never
 * register or authorise them.
 */

/** The outreach surface declared but not yet implemented as gateway tools. */
const OUTREACH_UNBOUND = [
  'outreach.discover_entities',
  'outreach.verify_entity',
  'outreach.classify_fit',
  'outreach.persist_prospects',
  'messaging.draft_outreach',
  'outreach.persist_drafts',
  'outreach.record_outcome',
  'outreach.refer',
];

function declaredToolIds(): string[] {
  const ids = new Set<string>();
  for (const spec of allAgentSpecs()) {
    for (const id of spec.allowedTools ?? []) ids.add(id);
  }
  return [...ids];
}

describe('AI-03.3 — declared tools are all classified (L-2)', () => {
  it('UNBOUND_DECLARED_TOOLS equals exactly the declared-but-unregistered ids', () => {
    const declared = declaredToolIds();
    const declaredUnbound = declared.filter((id) => !isRegisteredTool(id)).sort();
    expect([...UNBOUND_DECLARED_TOOLS].sort()).toEqual(declaredUnbound);
  });

  it('leaves no declared id unclassified (registered XOR unbound)', () => {
    const unbound = new Set(UNBOUND_DECLARED_TOOLS);
    for (const id of declaredToolIds()) {
      const registered = isRegisteredTool(id);
      expect(registered || unbound.has(id), `${id} is neither registered nor unbound`).toBe(true);
      expect(registered && unbound.has(id), `${id} cannot be both registered and unbound`).toBe(false);
    }
  });

  it('contains no duplicate entries', () => {
    expect(new Set(UNBOUND_DECLARED_TOOLS).size).toBe(UNBOUND_DECLARED_TOOLS.length);
  });

  it('lists the full outreach surface as unbound (8 ids, no duplicates)', () => {
    for (const id of OUTREACH_UNBOUND) {
      expect(UNBOUND_DECLARED_TOOLS, id).toContain(id);
    }
  });

  it('keeps every unbound id genuinely unregistered and inert (no fake handler/grant)', () => {
    for (const id of UNBOUND_DECLARED_TOOLS) {
      expect(findTool(id), id).toBeUndefined();
      expect(registeredToolIds(), id).not.toContain(id);
    }
    // The grant list is `allowedTools` ∩ registry, so an unbound id never grants.
    const outreach = AGENT_CATALOGUE.find((a) => a.key === 'outreach-acquisition-agent')!;
    const grant = toolGrantForAgent(outreach);
    for (const id of OUTREACH_UNBOUND) {
      expect(grant, id).not.toContain(id);
    }
    expect(grant).not.toContain('report.generate');
  });

  it('does not change any agent declaration (behaviour unchanged)', () => {
    const outreach = AGENT_CATALOGUE.find((a) => a.key === 'outreach-acquisition-agent')!;
    expect(outreach.allowedTools).toEqual([
      'outreach.discover_entities',
      'outreach.verify_entity',
      'outreach.classify_fit',
      'outreach.persist_prospects',
      'messaging.draft_outreach',
      'outreach.persist_drafts',
      'outreach.record_outcome',
      'outreach.refer',
      'report.generate',
    ]);
    expect(COPILOT_CATALOGUE.allowedTools).toEqual(['platform.metrics', 'report.generate']);
  });
});
