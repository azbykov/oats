import { defineConfig } from 'vitest/config'

// Calendar recurrences are expanded in local time, so the tests pin a zone with DST.
process.env.TZ = 'Europe/Berlin'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
