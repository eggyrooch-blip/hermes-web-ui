import { useProfilesStore } from '@/stores/hermes/profiles'

export async function ensureProfileSelection(): Promise<void> {
  const profilesStore = useProfilesStore()
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
}
