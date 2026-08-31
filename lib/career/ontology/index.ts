// The search ontology: the Evidence Bank restated as things to search for.
// See types.ts for the contract and the three rules it holds to.

export * from './types'
export { buildSearchOntology, cleanTitle, type BuildOntologyInput } from './build'
export { cueMatches, isStrongCue, normalizeText } from './detect'
export {
  applyOntologyOverrides, clearOntologyOverride, normalizeOverride, readOntologyOverrides,
  recordOntologyOverride, slugForLabel, withOntologyOverrides,
} from './overrides'
export {
  EMPTY_ONTOLOGY_LINE, ontologyQueryTerms, ontologyWeightedTerms, renderOntologyForPrompt,
  type QueryTermOptions, type RenderOntologyOptions, type WeightedQueryTerm,
} from './render'
export { COMBINATIONS, DISCIPLINES, discipline, type CombinationDef, type DisciplineDef } from './table'
export { INDUSTRIES, ROLE_FAMILIES, findByLabel, industry, roleFamily, type IndustryDef, type RoleFamilyDef } from './table-families'
