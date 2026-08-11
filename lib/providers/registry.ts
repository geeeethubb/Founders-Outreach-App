// Provider availability and feature flags.
//
// Callers ask the registry for a capability, not for a named vendor. An
// unavailable provider is skipped, never fatal — the app must work fully
// without PitchBook. See docs/ARCHITECTURE.md §4.
//
// Scaffolding: reports availability from environment configuration.
// Concrete providers register here in Phase 3.

import type { CompanyProvider, PeopleProvider, WebResearchProvider } from './types'

export type ProviderId = 'apollo' | 'pitchbook' | 'openai_web'

export interface ProviderAvailability {
  id: ProviderId
  available: boolean
  reason?: string  // why it is unavailable — surfaced in run diagnostics
}

/** Env-only checks. No network calls, safe to call anywhere. */
export function providerAvailability(): ProviderAvailability[] {
  return [
    {
      id: 'apollo',
      available: Boolean(process.env.APOLLO_API_KEY),
      reason: process.env.APOLLO_API_KEY ? undefined : 'APOLLO_API_KEY is not set',
    },
    {
      id: 'pitchbook',
      // Optional by design: requires BOTH an explicit flag and credentials, so
      // it can never be switched on by accident.
      available:
        process.env.PITCHBOOK_ENABLED === 'true' && Boolean(process.env.PITCHBOOK_API_KEY),
      reason:
        process.env.PITCHBOOK_ENABLED !== 'true'
          ? 'PITCHBOOK_ENABLED is not "true"'
          : process.env.PITCHBOOK_API_KEY
            ? undefined
            : 'PITCHBOOK_API_KEY is not set',
    },
    {
      id: 'openai_web',
      available: Boolean(process.env.OPENAI_API_KEY),
      reason: process.env.OPENAI_API_KEY ? undefined : 'OPENAI_API_KEY is not set',
    },
  ]
}

export function isProviderAvailable(id: ProviderId): boolean {
  return providerAvailability().find((p) => p.id === id)?.available ?? false
}

// ─── Registration (Phase 3) ──────────────────────────────────────────────────
// Implementations register themselves at module load. Until then these are
// empty and callers get an empty list, which is a valid degraded state.

const companyProviders: CompanyProvider[] = []
const peopleProviders: PeopleProvider[] = []
const webResearchProviders: WebResearchProvider[] = []

export function registerCompanyProvider(p: CompanyProvider): void {
  companyProviders.push(p)
}
export function registerPeopleProvider(p: PeopleProvider): void {
  peopleProviders.push(p)
}
export function registerWebResearchProvider(p: WebResearchProvider): void {
  webResearchProviders.push(p)
}

/** All registered, currently-available company providers. */
export function getCompanyProviders(): CompanyProvider[] {
  return companyProviders.filter((p) => p.isAvailable())
}
export function getPeopleProviders(): PeopleProvider[] {
  return peopleProviders.filter((p) => p.isAvailable())
}
export function getWebResearchProviders(): WebResearchProvider[] {
  return webResearchProviders.filter((p) => p.isAvailable())
}
