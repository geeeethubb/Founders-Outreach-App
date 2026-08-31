// The role-family and industry vocabulary. DATA, not logic.
//
// A family is a thing you can search a job board for. Its `titleVariants` are
// the titles that actually appear on postings — the query planner expands them
// (adding "intern", a season, a location) rather than inventing them, so a
// posting titled "Process Development Engineer, Summer Intern" is reachable
// from evidence that only ever said "chemical engineering".
//
// To extend: add a row here, then reference its id from a discipline or
// combination in table.ts. Nothing else changes.

export interface RoleFamilyDef {
  id: string
  label: string
  /** Base titles as they appear on postings. Intern/internship forms are added at query time. */
  titleVariants: string[]
  /** Function words this family contributes to `functionTerms` (what the work IS). */
  functionTerms?: string[]
}

export interface IndustryDef {
  id: string
  label: string
  /** Industries a person credible in this one is also credible in — the adjacency that widens the search. */
  adjacent?: string[]
}

export const ROLE_FAMILIES: RoleFamilyDef[] = [
  // ── Process / chemical ──
  { id: 'process_engineering', label: 'Process Engineering', titleVariants: ['Process Engineer', 'Process Engineering', 'Chemical Process Engineer', 'Plant Process Engineer'], functionTerms: ['process design', 'unit operations', 'scale-up'] },
  { id: 'process_development', label: 'Process Development', titleVariants: ['Process Development Engineer', 'Process Development', 'Process Scale-Up Engineer', 'Pilot Plant Engineer'], functionTerms: ['scale-up', 'pilot plant'] },
  { id: 'process_controls', label: 'Process Controls', titleVariants: ['Process Control Engineer', 'Controls Engineer', 'Automation Engineer', 'Instrumentation and Controls Engineer'], functionTerms: ['control systems', 'PLC', 'DCS'] },
  { id: 'chemical_engineering', label: 'Chemical Engineering', titleVariants: ['Chemical Engineer', 'Chemical Engineering', 'ChemE'], functionTerms: ['chemical engineering'] },
  { id: 'formulation', label: 'Formulation & Product Development', titleVariants: ['Formulation Scientist', 'Formulation Engineer', 'Product Development Engineer', 'Product Development Scientist'], functionTerms: ['formulation'] },

  // ── Manufacturing / operations ──
  { id: 'manufacturing_engineering', label: 'Manufacturing Engineering', titleVariants: ['Manufacturing Engineer', 'Manufacturing Engineering', 'Process Manufacturing Engineer'], functionTerms: ['manufacturing', 'production line'] },
  { id: 'production_engineering', label: 'Production Engineering', titleVariants: ['Production Engineer', 'Production Engineering', 'Plant Engineer'], functionTerms: ['production'] },
  { id: 'operations_engineering', label: 'Operations Engineering', titleVariants: ['Operations Engineer', 'Operations Engineering', 'Site Operations Engineer'], functionTerms: ['operations'] },
  { id: 'technical_operations', label: 'Technical Operations', titleVariants: ['Technical Operations', 'TechOps', 'Technical Operations Engineer', 'Operations Technology'], functionTerms: ['technical operations'] },
  { id: 'continuous_improvement', label: 'Continuous Improvement', titleVariants: ['Continuous Improvement Engineer', 'Lean Engineer', 'Operational Excellence', 'Six Sigma Engineer'], functionTerms: ['lean', 'six sigma', 'continuous improvement'] },
  { id: 'industrial_engineering', label: 'Industrial Engineering', titleVariants: ['Industrial Engineer', 'Industrial Engineering'], functionTerms: ['industrial engineering'] },

  // ── Quality / reliability / safety ──
  { id: 'quality_engineering', label: 'Quality Engineering', titleVariants: ['Quality Engineer', 'Quality Engineering', 'Quality Assurance Engineer', 'Supplier Quality Engineer'], functionTerms: ['quality', 'QA'] },
  { id: 'reliability_engineering', label: 'Reliability & Maintenance', titleVariants: ['Reliability Engineer', 'Maintenance Engineer', 'Asset Reliability Engineer'], functionTerms: ['reliability'] },
  { id: 'regulatory_affairs', label: 'Regulatory & Compliance', titleVariants: ['Regulatory Affairs', 'Compliance Engineer', 'Validation Engineer', 'Quality Systems'], functionTerms: ['regulatory', 'validation', 'compliance'] },
  { id: 'ehs', label: 'EHS & Process Safety', titleVariants: ['EHS Engineer', 'Process Safety Engineer', 'Health and Safety Engineer', 'Environmental Engineer'], functionTerms: ['process safety', 'EHS'] },

  // ── Materials / research ──
  { id: 'materials_engineering', label: 'Materials Engineering', titleVariants: ['Materials Engineer', 'Materials Scientist', 'Materials Science', 'Metallurgical Engineer'], functionTerms: ['materials'] },
  { id: 'rnd', label: 'R&D', titleVariants: ['R&D Engineer', 'Research and Development Engineer', 'Research Engineer', 'R&D Scientist', 'Research Scientist'], functionTerms: ['research', 'R&D'] },
  { id: 'lab_research', label: 'Laboratory Research', titleVariants: ['Research Assistant', 'Laboratory Technician', 'Research Associate', 'Lab Engineer'], functionTerms: ['laboratory'] },
  { id: 'computational_science', label: 'Computational Science & Modeling', titleVariants: ['Computational Scientist', 'Simulation Engineer', 'Modeling Engineer', 'Computational Chemist', 'Scientific Software Engineer'], functionTerms: ['simulation', 'modeling'] },

  // ── Software / data / AI ──
  { id: 'software_engineering', label: 'Software Engineering', titleVariants: ['Software Engineer', 'Software Developer', 'Software Engineering'], functionTerms: ['software'] },
  { id: 'data_science', label: 'Data Science', titleVariants: ['Data Scientist', 'Data Science', 'Applied Scientist'], functionTerms: ['data science'] },
  { id: 'data_analytics', label: 'Data & Business Analytics', titleVariants: ['Data Analyst', 'Business Analyst', 'Analytics', 'Business Intelligence Analyst'], functionTerms: ['analytics'] },
  { id: 'machine_learning', label: 'Machine Learning / AI', titleVariants: ['Machine Learning Engineer', 'AI Engineer', 'ML Engineer', 'Applied AI Engineer'], functionTerms: ['machine learning'] },
  { id: 'data_engineering', label: 'Data Engineering', titleVariants: ['Data Engineer', 'Analytics Engineer', 'Data Platform Engineer'], functionTerms: ['data pipelines'] },

  // ── Manufacturing × software ──
  // Title variants must not contain commas: they are rendered as comma-joined lists.
  { id: 'industrial_ai', label: 'Industrial AI', titleVariants: ['Industrial AI Engineer', 'Manufacturing AI Engineer', 'Industrial Machine Learning Engineer', 'Applied AI Engineer Operations'], functionTerms: ['industrial AI'] },
  { id: 'digital_manufacturing', label: 'Digital Manufacturing', titleVariants: ['Digital Manufacturing Engineer', 'Smart Manufacturing Engineer', 'Manufacturing Systems Engineer', 'MES Engineer', 'Industry 4.0 Engineer'], functionTerms: ['digital manufacturing', 'MES'] },
  { id: 'operations_technology', label: 'Operations Technology', titleVariants: ['Operations Technology Engineer', 'OT Engineer', 'Manufacturing IT', 'Digital Operations Engineer'], functionTerms: ['operations technology'] },
  { id: 'automation_controls', label: 'Automation & Robotics', titleVariants: ['Automation Engineer', 'Robotics Engineer', 'Controls and Automation Engineer', 'Mechatronics Engineer'], functionTerms: ['automation', 'robotics'] },
  { id: 'technical_product', label: 'Technical Product', titleVariants: ['Product Manager', 'Technical Product Manager', 'Associate Product Manager', 'Product Analyst'], functionTerms: ['product management'] },
  { id: 'forward_deployed', label: 'Forward Deployed / Solutions', titleVariants: ['Forward Deployed Engineer', 'Solutions Engineer', 'Implementation Engineer', 'Technical Solutions'], functionTerms: ['deployment', 'solutions'] },

  // ── Mechanical / electrical / systems ──
  { id: 'mechanical_engineering', label: 'Mechanical Engineering', titleVariants: ['Mechanical Engineer', 'Mechanical Design Engineer', 'Mechanical Engineering'], functionTerms: ['mechanical design'] },
  { id: 'electrical_engineering', label: 'Electrical Engineering', titleVariants: ['Electrical Engineer', 'Electrical Engineering', 'Power Systems Engineer'], functionTerms: ['electrical'] },
  { id: 'systems_engineering', label: 'Systems Engineering', titleVariants: ['Systems Engineer', 'Systems Engineering', 'Test Engineer', 'Integration Engineer'], functionTerms: ['systems engineering'] },
  { id: 'design_engineering', label: 'Design Engineering', titleVariants: ['Design Engineer', 'Product Design Engineer', 'CAD Engineer'], functionTerms: ['design'] },

  // ── Energy / environment ──
  { id: 'energy_engineering', label: 'Energy Engineering', titleVariants: ['Energy Engineer', 'Energy Systems Engineer', 'Renewable Energy Engineer', 'Battery Engineer'], functionTerms: ['energy systems'] },
  { id: 'sustainability', label: 'Sustainability & Decarbonization', titleVariants: ['Sustainability Analyst', 'Sustainability Engineer', 'Decarbonization Analyst', 'Life Cycle Assessment Analyst', 'Climate Analyst'], functionTerms: ['sustainability', 'life cycle assessment'] },

  // ── Life sciences ──
  { id: 'bioprocess', label: 'Bioprocess Engineering', titleVariants: ['Bioprocess Engineer', 'Biomanufacturing Engineer', 'Downstream Process Engineer', 'Upstream Process Engineer', 'Cell Culture Engineer'], functionTerms: ['bioprocess', 'biomanufacturing'] },
  { id: 'biotech_research', label: 'Life Sciences Research', titleVariants: ['Research Associate', 'Scientist', 'Biology Research Intern', 'Genomics Research Associate'], functionTerms: ['life sciences'] },
  { id: 'computational_biology', label: 'Computational Biology & Bioinformatics', titleVariants: ['Computational Biologist', 'Bioinformatics Scientist', 'Bioinformatics Engineer'], functionTerms: ['bioinformatics'] },

  // ── Supply chain / commercial / business ──
  { id: 'supply_chain', label: 'Supply Chain & Logistics', titleVariants: ['Supply Chain Analyst', 'Supply Chain Engineer', 'Logistics Analyst', 'Procurement Analyst', 'Planning Analyst'], functionTerms: ['supply chain'] },
  { id: 'strategy_consulting', label: 'Strategy & Consulting', titleVariants: ['Strategy Analyst', 'Business Analyst', 'Consultant', 'Corporate Strategy Analyst'], functionTerms: ['strategy'] },
  { id: 'finance', label: 'Finance & Investing', titleVariants: ['Investment Analyst', 'Financial Analyst', 'Venture Capital Analyst', 'Corporate Development Analyst'], functionTerms: ['finance'] },
  { id: 'technical_program', label: 'Technical Program & Project', titleVariants: ['Technical Program Manager', 'Project Engineer', 'Program Analyst', 'Project Management'], functionTerms: ['program management'] },
  { id: 'field_applications', label: 'Field & Applications Engineering', titleVariants: ['Applications Engineer', 'Field Engineer', 'Technical Sales Engineer', 'Customer Engineer'], functionTerms: ['applications engineering'] },
]

export const INDUSTRIES: IndustryDef[] = [
  { id: 'chemicals', label: 'Chemicals', adjacent: ['specialty_chemicals', 'materials', 'energy', 'cpg', 'pharma'] },
  { id: 'specialty_chemicals', label: 'Specialty Chemicals', adjacent: ['chemicals', 'materials', 'coatings'] },
  { id: 'coatings', label: 'Coatings & Adhesives', adjacent: ['specialty_chemicals', 'materials'] },
  { id: 'materials', label: 'Advanced Materials', adjacent: ['chemicals', 'semiconductors', 'aerospace', 'batteries'] },
  { id: 'advanced_manufacturing', label: 'Advanced Manufacturing', adjacent: ['industrial', 'automotive', 'aerospace', 'robotics', 'semiconductors'] },
  { id: 'industrial', label: 'Industrial & Machinery', adjacent: ['advanced_manufacturing', 'energy', 'automotive'] },
  { id: 'automotive', label: 'Automotive & Mobility', adjacent: ['advanced_manufacturing', 'batteries', 'robotics'] },
  { id: 'aerospace', label: 'Aerospace & Defense', adjacent: ['advanced_manufacturing', 'materials'] },
  { id: 'semiconductors', label: 'Semiconductors', adjacent: ['materials', 'advanced_manufacturing', 'electronics'] },
  { id: 'electronics', label: 'Electronics & Hardware', adjacent: ['semiconductors', 'robotics'] },
  { id: 'robotics', label: 'Robotics & Automation', adjacent: ['advanced_manufacturing', 'industrial_software', 'electronics'] },
  { id: 'energy', label: 'Energy', adjacent: ['oil_gas', 'renewables', 'utilities', 'chemicals'] },
  { id: 'oil_gas', label: 'Oil & Gas', adjacent: ['energy', 'chemicals', 'utilities'] },
  { id: 'renewables', label: 'Renewables & Clean Energy', adjacent: ['energy', 'batteries', 'climate_tech', 'utilities'] },
  { id: 'batteries', label: 'Batteries & Storage', adjacent: ['materials', 'renewables', 'automotive'] },
  { id: 'utilities', label: 'Utilities & Grid', adjacent: ['energy', 'renewables'] },
  { id: 'climate_tech', label: 'Climate Tech', adjacent: ['renewables', 'carbon', 'energy'] },
  { id: 'carbon', label: 'Carbon Capture & Removal', adjacent: ['climate_tech', 'chemicals', 'energy'] },
  { id: 'pharma', label: 'Pharmaceuticals', adjacent: ['biotech', 'medtech', 'chemicals'] },
  { id: 'biotech', label: 'Biotechnology', adjacent: ['pharma', 'life_sciences_tools', 'medtech'] },
  { id: 'life_sciences_tools', label: 'Life Sciences Tools & Diagnostics', adjacent: ['biotech', 'medtech'] },
  { id: 'medtech', label: 'Medical Technology & Devices', adjacent: ['pharma', 'biotech', 'electronics'] },
  { id: 'food_bev', label: 'Food & Beverage', adjacent: ['cpg', 'agriculture', 'advanced_manufacturing'] },
  { id: 'cpg', label: 'Consumer Packaged Goods', adjacent: ['food_bev', 'chemicals', 'advanced_manufacturing'] },
  { id: 'agriculture', label: 'Agriculture & AgTech', adjacent: ['food_bev', 'climate_tech', 'chemicals'] },
  { id: 'industrial_software', label: 'Industrial Software', adjacent: ['advanced_manufacturing', 'robotics', 'enterprise_software'] },
  { id: 'enterprise_software', label: 'Enterprise Software', adjacent: ['industrial_software', 'ai'] },
  { id: 'ai', label: 'AI & Machine Learning', adjacent: ['enterprise_software', 'industrial_software', 'data_infrastructure'] },
  { id: 'data_infrastructure', label: 'Data Infrastructure', adjacent: ['enterprise_software', 'ai'] },
  { id: 'mining_metals', label: 'Mining & Metals', adjacent: ['materials', 'industrial', 'energy'] },
  { id: 'water', label: 'Water & Environmental Services', adjacent: ['utilities', 'climate_tech', 'chemicals'] },
  { id: 'logistics', label: 'Logistics & Supply Chain', adjacent: ['advanced_manufacturing', 'industrial'] },
  { id: 'professional_services', label: 'Consulting & Professional Services', adjacent: ['finance_services'] },
  { id: 'finance_services', label: 'Finance & Investing', adjacent: ['professional_services'] },
]

const FAMILY_INDEX = new Map(ROLE_FAMILIES.map((f) => [f.id, f]))
const INDUSTRY_INDEX = new Map(INDUSTRIES.map((i) => [i.id, i]))

export function roleFamily(id: string): RoleFamilyDef | null {
  return FAMILY_INDEX.get(id) ?? null
}

export function industry(id: string): IndustryDef | null {
  return INDUSTRY_INDEX.get(id) ?? null
}

/** A family or industry whose label matches, case- and punctuation-insensitively. Used by ADD overrides. */
export function findByLabel(label: string): { family: RoleFamilyDef | null; industry: IndustryDef | null } {
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const match = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === key
  return {
    family: ROLE_FAMILIES.find((f) => match(f.label) || match(f.id) || f.titleVariants.some(match)) ?? null,
    industry: INDUSTRIES.find((i) => match(i.label) || match(i.id)) ?? null,
  }
}
