import { LayoutTemplate, Lock, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { Template } from '../../../shared/types'
import { uid, useStore } from '../lib/store'
import { Button, IconButton } from './ui'

function TemplateEditor({ template, onClose }: { template: Template; onClose: () => void }) {
  const { saveTemplate, deleteTemplate } = useStore.getState()
  const [draft, setDraft] = useState(template)
  const readOnly = !!template.builtIn
  const set = (patch: Partial<Template>) => setDraft((d) => ({ ...d, ...patch }))
  const field =
    'w-full rounded-lg border border-hairline bg-fill-input px-3 py-2 text-[13px] outline-none focus:border-ink-accent disabled:opacity-70'

  return (
    <div className="rounded-2xl border border-hairline bg-surface-elevated p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[15px] font-semibold text-ink-strong">
          {readOnly ? template.title : template.title ? 'Edit template' : 'New template'}
        </h3>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      {readOnly && (
        <p className="mb-4 flex items-center gap-1.5 text-[12px] text-ink-tertiary">
          <Lock size={12} /> Built-in templates can’t be edited. Duplicate it to customise.
        </p>
      )}
      <label className="mb-1 block text-[12px] text-ink-secondary">Name</label>
      <input disabled={readOnly} className={`${field} mb-3`} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      <label className="mb-1 block text-[12px] text-ink-secondary">Description</label>
      <input
        disabled={readOnly}
        className={`${field} mb-4`}
        value={draft.description}
        onChange={(e) => set({ description: e.target.value })}
      />
      {(!readOnly || draft.instructions) && (
        <>
          <label className="mb-1 block text-[12px] text-ink-secondary">Instructions (optional)</label>
          <textarea
            disabled={readOnly}
            rows={3}
            className={`${field} mb-4 resize-y leading-snug`}
            placeholder="Guidance for the whole document, e.g. “Keep it under 10 bullets” or “Write for a customer email”."
            value={draft.instructions ?? ''}
            onChange={(e) => set({ instructions: e.target.value })}
          />
        </>
      )}
      <div className="mb-2 text-[12px] text-ink-secondary">Sections</div>
      <div className="space-y-2">
        {draft.sections.map((s, i) => (
          <div key={i} className="flex gap-2">
            <div className="flex-1 space-y-1.5">
              <input
                disabled={readOnly}
                className={`${field} font-medium`}
                placeholder="Heading"
                value={s.heading}
                onChange={(e) =>
                  set({ sections: draft.sections.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)) })
                }
              />
              <input
                disabled={readOnly}
                className={field}
                placeholder="What should go in this section?"
                value={s.instructions}
                onChange={(e) =>
                  set({
                    sections: draft.sections.map((x, j) => (j === i ? { ...x, instructions: e.target.value } : x))
                  })
                }
              />
            </div>
            {!readOnly && (
              <IconButton label="Remove section" onClick={() => set({ sections: draft.sections.filter((_, j) => j !== i) })}>
                <Trash2 size={14} />
              </IconButton>
            )}
          </div>
        ))}
        {!draft.sections.length && (
          <p className="text-[12px] text-ink-tertiary">
            {draft.instructions?.trim()
              ? 'No fixed sections: the AI follows the instructions above.'
              : 'No fixed sections: the AI picks a structure and puts off-topic parts under “Other topics”.'}
          </p>
        )}
      </div>
      <div className="mt-5 flex items-center justify-between">
        {readOnly ? (
          <span />
        ) : (
          <Button variant="ghost" size="sm" onClick={() => set({ sections: [...draft.sections, { heading: '', instructions: '' }] })}>
            <Plus size={14} /> Add section
          </Button>
        )}
        <div className="flex gap-2">
          {!readOnly && template.title && (
            <Button
              variant="ghost"
              onClick={() => {
                deleteTemplate(template.id)
                onClose()
              }}
            >
              Delete
            </Button>
          )}
          {readOnly ? (
            <Button
              variant="primary"
              onClick={() => {
                saveTemplate({ ...template, id: uid(), title: `${template.title} (copy)`, builtIn: false })
                onClose()
              }}
            >
              Duplicate
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!draft.title.trim()}
              onClick={() => {
                saveTemplate({ ...draft, sections: draft.sections.filter((s) => s.heading.trim()) })
                onClose()
              }}
            >
              Save
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export function TemplatesView() {
  const templates = useStore((s) => s.data!.templates)
  const [editing, setEditing] = useState<Template | null>(null)

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-[52px] shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto pb-16">
        <div className="mx-auto w-full max-w-2xl px-6">
          <div className="mb-1 flex items-center justify-between">
            <h1 className="font-display text-[28px] tracking-tight text-ink-strong">Templates</h1>
            <Button
              variant="outline"
              onClick={() => setEditing({ id: uid(), title: '', description: '', sections: [{ heading: '', instructions: '' }] })}
            >
              <Plus size={14} /> New template
            </Button>
          </div>
          <p className="mb-6 text-[13px] text-ink-secondary">
            Templates shape how your notes are enhanced after a meeting.
          </p>
          {editing && (
            <div className="mb-6">
              <TemplateEditor key={editing.id} template={editing} onClose={() => setEditing(null)} />
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setEditing(t)}
                className="flex cursor-default items-start gap-3 rounded-xl border border-hairline bg-surface-elevated p-3.5 text-left hover:bg-fill-soft"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-oats-green-50 text-ink-accent dark:bg-oats-green-700">
                  <LayoutTemplate size={15} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium text-ink-primary">{t.title}</span>
                  <span className="block text-[12px] leading-snug text-ink-tertiary">{t.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
