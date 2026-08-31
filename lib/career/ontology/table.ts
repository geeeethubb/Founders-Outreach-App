// Discipline → role family mapping. DATA, not logic.
//
// A DISCIPLINE is what the evidence says a person has actually done. Its
// `cues` are the words that betray it in prose; its families are what someone
// with that discipline can credibly apply to — CORE (obviously them) and
// ADJACENT (a real stretch worth searching, because the founder's brief is to
// find the roles they would otherwise MISS).
//
// A COMBINATION fires only when two disciplines are both attested, and that is
// where the interesting jobs live: manufacturing × AI is not the union of
// "Manufacturing Engineer" and "ML Engineer", it is "Industrial AI Engineer".
//
// Cue syntax, deliberately tiny:
//   "process"            single word — matched against STEMMED tokens
//   "manufactur*"        prefix — matched against stem prefixes. Use this for
//                        any inflected stem; a truncated stem without the star
//                        matches nothing (see CLAUDE.md, the `\bmanufactur\b` trap)
//   "process engineer*"  phrase — matched as a padded substring, star = prefix
//
// To extend: add cues, add a row, or point a discipline at another family id
// from table-families.ts. No code changes.

export interface DisciplineDef {
  id: string
  label: string
  /** Words that indicate this discipline in evidence prose. Order is the order `matchedCues` reports. */
  cues: string[]
  /** Families this discipline obviously qualifies for. */
  coreFamilies: string[]
  /** Families worth searching because the discipline transfers. This is the recall lever. */
  adjacentFamilies: string[]
  /** Industry ids from table-families.ts. Their `adjacent` lists become adjacentIndustries. */
  industries: string[]
  /** Domain vocabulary this discipline contributes to `skillTerms` regardless of the bank's skill rows. */
  skillTerms?: string[]
}

export interface CombinationDef {
  id: string
  label: string
  /** Every discipline id here must be detected for the combination to fire. */
  requires: string[]
  families: string[]
  industries: string[]
}

/** How much of a discipline's confidence a family inherits. */
export const CORE_STRENGTH = 0.95
export const ADJACENT_STRENGTH = 0.7
export const COMBINATION_STRENGTH = 0.9
/** Industries inherit like families; an industry's own adjacents are one more step out. */
export const INDUSTRY_ADJACENT_STRENGTH = 0.65

export const DISCIPLINES: DisciplineDef[] = [
  {
    id: 'chemical_engineering',
    label: 'Chemical Engineering',
    cues: [
      'chemical engineer*', 'cheme', 'chemical engineering', 'process engineer*', 'unit operation*',
      'distillation', 'reactor', 'reaction engineering', 'mass transfer', 'heat transfer', 'thermodynamic*',
      'fluid mechanic*', 'separation*', 'aspen', 'p&id', 'catalysis', 'catalyst', 'polymer*', 'formulation',
      'scale-up', 'scale up', 'pilot plant', 'stoichiometry', 'chemistry', 'chemical',
    ],
    coreFamilies: [
      'chemical_engineering', 'process_engineering', 'process_development', 'manufacturing_engineering',
      'quality_engineering', 'materials_engineering', 'rnd', 'process_controls', 'operations_engineering',
      'production_engineering', 'technical_operations', 'formulation',
    ],
    adjacentFamilies: ['ehs', 'reliability_engineering', 'continuous_improvement', 'industrial_engineering', 'field_applications', 'technical_program', 'bioprocess', 'energy_engineering', 'sustainability'],
    industries: ['chemicals', 'specialty_chemicals', 'materials', 'advanced_manufacturing', 'energy', 'cpg'],
    skillTerms: ['process design', 'mass and energy balance', 'scale-up', 'unit operations'],
  },
  {
    id: 'materials_science',
    label: 'Materials Science',
    cues: ['materials science', 'material science', 'metallurg*', 'polymer*', 'composite*', 'ceramic*', 'crystallograph*', 'characterization', 'sem', 'xrd', 'tem', 'corrosion', 'coating*', 'thin film*', 'nanomaterial*'],
    coreFamilies: ['materials_engineering', 'rnd', 'process_development', 'quality_engineering', 'lab_research'],
    adjacentFamilies: ['manufacturing_engineering', 'design_engineering', 'computational_science', 'process_engineering'],
    industries: ['materials', 'semiconductors', 'chemicals', 'batteries', 'aerospace'],
    skillTerms: ['materials characterization', 'failure analysis'],
  },
  {
    id: 'mechanical_engineering',
    label: 'Mechanical Engineering',
    cues: ['mechanical engineer*', 'solidworks', 'cad', 'finite element', 'fea', 'cfd', 'tolerance*', 'machining', 'fixture*', 'thermal design', 'hvac', 'mechatronic*', 'gd&t'],
    coreFamilies: ['mechanical_engineering', 'design_engineering', 'manufacturing_engineering', 'systems_engineering', 'rnd'],
    adjacentFamilies: ['automation_controls', 'reliability_engineering', 'production_engineering', 'technical_operations', 'quality_engineering', 'energy_engineering'],
    industries: ['advanced_manufacturing', 'industrial', 'automotive', 'aerospace', 'robotics'],
  },
  {
    id: 'electrical_engineering',
    label: 'Electrical Engineering',
    cues: ['electrical engineer*', 'circuit*', 'pcb', 'embedded', 'firmware', 'power system*', 'power electronic*', 'signal processing', 'fpga', 'sensor*', 'instrumentation'],
    coreFamilies: ['electrical_engineering', 'systems_engineering', 'automation_controls', 'process_controls', 'rnd'],
    adjacentFamilies: ['manufacturing_engineering', 'design_engineering', 'energy_engineering', 'field_applications', 'technical_operations'],
    industries: ['electronics', 'semiconductors', 'energy', 'utilities', 'robotics'],
  },
  {
    id: 'software_ai',
    label: 'Software & AI',
    cues: [
      'software', 'python', 'typescript', 'javascript', 'react', 'sql', 'api', 'backend', 'frontend', 'full-stack',
      'machine learning', 'deep learning', 'neural network*', 'llm', 'large language model*', 'agentic', 'ai agent*',
      'artificial intelligence', 'nlp', 'pytorch', 'tensorflow', 'algorithm*', 'codebase', 'git', 'docker',
    ],
    coreFamilies: ['software_engineering', 'machine_learning', 'data_engineering', 'data_science'],
    adjacentFamilies: ['technical_product', 'forward_deployed', 'computational_science', 'data_analytics', 'systems_engineering', 'automation_controls'],
    industries: ['enterprise_software', 'ai', 'data_infrastructure', 'industrial_software'],
    skillTerms: ['software engineering', 'machine learning'],
  },
  {
    id: 'data_analytics',
    label: 'Data & Analytics',
    cues: ['data analysis', 'analytics', 'dashboard*', 'statistic*', 'regression', 'forecast*', 'excel model*', 'tableau', 'power bi', 'pandas', 'dataset*', 'a/b test*', 'techno-economic', 'quantitative'],
    coreFamilies: ['data_analytics', 'data_science'],
    adjacentFamilies: ['data_engineering', 'strategy_consulting', 'technical_product', 'supply_chain', 'finance'],
    industries: ['enterprise_software', 'ai', 'professional_services'],
    skillTerms: ['data analysis', 'statistics'],
  },
  {
    id: 'manufacturing_operations',
    label: 'Manufacturing & Operations',
    cues: [
      'manufactur*', 'production line*', 'plant', 'factory', 'shop floor', 'throughput', 'yield', 'downtime',
      'oee', 'lean', 'six sigma', 'kaizen', 'takt', 'assembly', 'operations', 'sop', 'process improvement',
      'cycle time', 'capacity', 'maintenance', 'mes', 'scada',
    ],
    coreFamilies: [
      'manufacturing_engineering', 'production_engineering', 'operations_engineering', 'technical_operations',
      'continuous_improvement', 'industrial_engineering', 'process_engineering', 'quality_engineering',
    ],
    adjacentFamilies: ['reliability_engineering', 'supply_chain', 'automation_controls', 'ehs', 'technical_program', 'process_controls'],
    industries: ['advanced_manufacturing', 'industrial', 'automotive', 'cpg', 'food_bev'],
    skillTerms: ['lean manufacturing', 'process improvement'],
  },
  {
    id: 'quality_regulatory',
    label: 'Quality & Regulatory',
    cues: ['quality assurance', 'quality control', 'qa', 'qc', 'validation', 'gmp', 'iso 9001', 'audit*', 'capa', 'compliance', 'regulatory', 'fda', 'specification*', 'root cause', 'deviation*'],
    coreFamilies: ['quality_engineering', 'regulatory_affairs', 'reliability_engineering'],
    adjacentFamilies: ['manufacturing_engineering', 'process_engineering', 'ehs', 'technical_operations', 'bioprocess'],
    industries: ['pharma', 'medtech', 'advanced_manufacturing', 'food_bev'],
  },
  {
    id: 'life_sciences',
    label: 'Life Sciences',
    cues: ['biolog*', 'biotech*', 'genomic*', 'molecular', 'cell culture', 'bioprocess', 'fermentation', 'assay*', 'pcr', 'protein*', 'clinical', 'pharmaceutic*', 'drug', 'microbiolog*', 'crispr', 'sequencing'],
    coreFamilies: ['bioprocess', 'biotech_research', 'lab_research', 'rnd'],
    adjacentFamilies: ['process_development', 'quality_engineering', 'regulatory_affairs', 'manufacturing_engineering', 'computational_biology'],
    industries: ['biotech', 'pharma', 'life_sciences_tools', 'medtech'],
  },
  {
    id: 'energy_climate',
    label: 'Energy & Climate',
    cues: ['energy', 'hydrogen', 'fuel cell*', 'solar', 'wind', 'battery', 'batteries', 'electrolysis', 'decarboniz*', 'carbon capture', 'emission*', 'life cycle assessment', 'lca', 'sustainab*', 'renewable*', 'grid', 'biofuel*', 'geothermal', 'nuclear'],
    coreFamilies: ['energy_engineering', 'sustainability', 'process_engineering', 'rnd'],
    adjacentFamilies: ['materials_engineering', 'operations_engineering', 'technical_program', 'strategy_consulting', 'ehs', 'data_analytics'],
    industries: ['energy', 'renewables', 'climate_tech', 'batteries', 'utilities', 'carbon'],
  },
  {
    id: 'supply_chain',
    label: 'Supply Chain',
    cues: ['supply chain', 'logistic*', 'procurement', 'sourcing', 'inventory', 'supplier*', 'feedstock', 'demand planning', 'warehouse', 'distribution'],
    coreFamilies: ['supply_chain', 'industrial_engineering', 'operations_engineering'],
    adjacentFamilies: ['data_analytics', 'technical_program', 'manufacturing_engineering', 'strategy_consulting'],
    industries: ['logistics', 'advanced_manufacturing', 'cpg', 'industrial'],
  },
  {
    id: 'business_strategy',
    label: 'Business & Strategy',
    cues: ['consulting', 'strategy', 'market analysis', 'due diligence', 'business development', 'valuation', 'financial model*', 'go-to-market', 'm&a', 'venture capital', 'startup', 'founder', 'p&l', 'customer discovery'],
    coreFamilies: ['strategy_consulting', 'finance', 'technical_program'],
    adjacentFamilies: ['technical_product', 'data_analytics', 'field_applications', 'supply_chain'],
    industries: ['professional_services', 'finance_services', 'enterprise_software'],
  },
  {
    id: 'research_science',
    label: 'Research & Computation',
    cues: ['research', 'publication*', 'peer-reviewed', 'thesis', 'laborator*', 'experiment*', 'simulation', 'computational', 'dft', 'monte carlo', 'modeling', 'modelling', 'matlab', 'numerical', 'first-principles'],
    coreFamilies: ['rnd', 'lab_research', 'computational_science'],
    adjacentFamilies: ['process_development', 'data_science', 'materials_engineering', 'biotech_research', 'systems_engineering'],
    industries: ['materials', 'biotech', 'ai', 'chemicals'],
  },
  {
    id: 'product_design',
    label: 'Product & Design',
    cues: ['product manage*', 'roadmap', 'user research', 'ux', 'prototyp*', 'wireframe*', 'product requirement*', 'customer interview*', 'feature*', 'design thinking'],
    coreFamilies: ['technical_product', 'design_engineering'],
    adjacentFamilies: ['forward_deployed', 'data_analytics', 'strategy_consulting', 'systems_engineering'],
    industries: ['enterprise_software', 'ai', 'electronics'],
  },
]

export const COMBINATIONS: CombinationDef[] = [
  {
    id: 'industrial_ai',
    label: 'Manufacturing × AI/software',
    requires: ['manufacturing_operations', 'software_ai'],
    families: ['industrial_ai', 'digital_manufacturing', 'operations_technology', 'automation_controls', 'technical_product', 'forward_deployed'],
    industries: ['industrial_software', 'ai', 'advanced_manufacturing', 'robotics'],
  },
  {
    id: 'process_computation',
    label: 'Chemical engineering × software',
    requires: ['chemical_engineering', 'software_ai'],
    families: ['computational_science', 'data_science', 'industrial_ai', 'digital_manufacturing'],
    industries: ['industrial_software', 'ai', 'chemicals'],
  },
  {
    id: 'bio_process',
    label: 'Life sciences × process engineering',
    requires: ['life_sciences', 'chemical_engineering'],
    families: ['bioprocess', 'process_development', 'regulatory_affairs'],
    industries: ['biotech', 'pharma', 'life_sciences_tools'],
  },
  {
    id: 'computational_bio',
    label: 'Life sciences × software',
    requires: ['life_sciences', 'software_ai'],
    families: ['computational_biology', 'data_science', 'lab_research'],
    industries: ['biotech', 'life_sciences_tools', 'ai'],
  },
  {
    id: 'clean_process',
    label: 'Energy/climate × process engineering',
    requires: ['energy_climate', 'chemical_engineering'],
    families: ['sustainability', 'energy_engineering', 'process_development'],
    industries: ['climate_tech', 'renewables', 'carbon', 'batteries'],
  },
  {
    id: 'materials_energy',
    label: 'Materials × energy',
    requires: ['materials_science', 'energy_climate'],
    families: ['materials_engineering', 'energy_engineering', 'rnd'],
    industries: ['batteries', 'renewables', 'materials'],
  },
  {
    id: 'quant_strategy',
    label: 'Analytics × business',
    requires: ['data_analytics', 'business_strategy'],
    families: ['strategy_consulting', 'finance', 'technical_product', 'data_analytics'],
    industries: ['professional_services', 'finance_services'],
  },
  {
    id: 'ops_analytics',
    label: 'Operations × analytics',
    requires: ['manufacturing_operations', 'data_analytics'],
    families: ['data_analytics', 'continuous_improvement', 'supply_chain', 'operations_technology'],
    industries: ['advanced_manufacturing', 'logistics', 'industrial_software'],
  },
]

const DISCIPLINE_INDEX = new Map(DISCIPLINES.map((d) => [d.id, d]))

export function discipline(id: string): DisciplineDef | null {
  return DISCIPLINE_INDEX.get(id) ?? null
}
