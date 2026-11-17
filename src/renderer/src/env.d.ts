import type { LibraryAPI } from '../../shared/library'

declare global {
  interface Window { library: LibraryAPI }
}
