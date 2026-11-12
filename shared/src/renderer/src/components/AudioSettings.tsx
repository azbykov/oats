import { ChevronUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MicSource } from '../../../common/types'
import { microphones } from '../lib/capture'
import { useStore } from '../lib/store'
import { IconButton, MenuLabel, Popover } from './ui'

/** Settings → Microphone; also in the note's audio menu. Changes apply to a running session. */
export function MicrophoneSelect({ className = '' }: { className?: string }) {
  const settings = useStore((s) => s.data!.settings)
  const update = useStore((s) => s.updateSettings)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    const load = () =>
      microphones()
        .then(setDevices)
        .catch(() => setDevices([]))
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => navigator.mediaDevices.removeEventListener('devicechange', load)
  }, [])
  const value = settings.micSource === 'device' ? `device:${settings.micLabel}` : settings.micSource
  const missing = settings.micSource === 'device' && !devices.some((d) => d.label === settings.micLabel)
  return (
    <select
      className={className}
      value={value}
      onChange={(e) => {
        const v = e.target.value
        if (v.startsWith('device:')) update({ micSource: 'device', micLabel: v.slice('device:'.length) })
        else update({ micSource: v as MicSource })
      }}
    >
      <option value="call">Same as the call</option>
      <option value="system">System default</option>
      {/* Labels stay empty until microphone access is granted. */}
      {devices.map((d, i) => (
        <option key={d.deviceId} value={`device:${d.label}`} disabled={!d.label}>
          {d.label || `Microphone ${i + 1}`}
        </option>
      ))}
      {missing && <option value={value}>{settings.micLabel} (not connected)</option>}
    </select>
  )
}

const select =
  'h-8 w-full rounded-lg border border-hairline bg-fill-input px-2 text-[13px] text-ink-primary outline-none focus:border-ink-accent'

/** The transcription pill's audio menu: which mic is "Me" and whether "Them" is captured. */
export function AudioMenu({ live }: { live: boolean }) {
  const captureSystemAudio = useStore((s) => s.data!.settings.captureSystemAudio)
  const micLabel = useStore((s) => s.recording.micLabel)
  const update = useStore((s) => s.updateSettings)
  const navigate = useStore((s) => s.navigate)
  return (
    <Popover
      side="top"
      trigger={({ open, toggle }) => (
        <IconButton label="Audio settings" className={`size-8 rounded-full ${open ? 'bg-fill-soft' : ''}`} onClick={toggle}>
          <ChevronUp size={14} />
        </IconButton>
      )}
    >
      {(close) => (
        <div className="w-72 px-1 pb-1">
          <MenuLabel>Microphone</MenuLabel>
          <div className="px-1.5">
            <MicrophoneSelect className={select} />
            {live && micLabel && (
              <div className="mt-1 truncate text-[11px] text-ink-tertiary" title={micLabel}>
                Recording from {micLabel}
              </div>
            )}
          </div>
          <MenuLabel>Other participants</MenuLabel>
          <label className="flex items-start gap-2 px-1.5 text-[13px] text-ink-primary">
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--fill-accent)]"
              checked={captureSystemAudio}
              onChange={(e) => update({ captureSystemAudio: e.target.checked })}
            />
            <span>
              Capture system audio
              <span className="block text-[11px] leading-snug text-ink-tertiary">
                Their voices from Zoom, Meet or Teams{live ? '. Changing it restarts transcription.' : '.'}
              </span>
            </span>
          </label>
          <button
            type="button"
            onClick={() => {
              close()
              navigate({ view: 'settings', tab: 'transcription' })
            }}
            className="mt-2 w-full cursor-default rounded-lg px-1.5 py-1 text-left text-[12px] text-ink-accent hover:bg-fill-soft"
          >
            All transcription settings…
          </button>
        </div>
      )}
    </Popover>
  )
}
