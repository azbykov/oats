import { safeStorage } from 'electron'

// Secrets kept on disk (sign-in tokens, app passwords) are encrypted with the OS
// keychain: Keychain on macOS, DPAPI on Windows.

export function seal(value: unknown) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this computer')
  return safeStorage.encryptString(JSON.stringify(value)).toString('base64')
}

export const unseal = <T>(sealed: string) => JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64'))) as T
