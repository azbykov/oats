import { Extension } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef } from 'react'
import { PersonMention, useMentionCard } from './Mentions'

// Keeps the ai-text / user-text classes on generated notes when they are edited.
const AuthorshipClass = Extension.create({
  name: 'authorshipClass',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'listItem', 'heading'],
        attributes: {
          class: {
            default: null,
            parseHTML: (el) => el.getAttribute('class'),
            renderHTML: (attrs) => (attrs.class ? { class: attrs.class } : {})
          }
        }
      }
    ]
  }
})

// ⌘⇧V pastes the clipboard as plain text, dropping the formatting of whatever it was copied from.
const PlainPaste = Extension.create({
  name: 'plainPaste',
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-v': () => {
        window.oats
          .readClipboardText()
          .then((text) => text && this.editor.view.pasteText(text))
          .catch(() => {})
        return true
      }
    }
  }
})

export function NoteEditor({
  html,
  placeholder,
  onChange,
  autofocus,
  onReady,
  noteId
}: {
  html: string
  placeholder: string
  onChange: (html: string) => void
  autofocus?: boolean
  onReady?: (editor: Editor) => void
  /** The note being edited, so @-mentions suggest its attendees first. */
  noteId?: string
}) {
  const noteRef = useRef(noteId)
  noteRef.current = noteId
  const mentionCard = useMentionCard()
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder }),
      AuthorshipClass,
      PersonMention(() => noteRef.current),
      PlainPaste
    ],
    content: html,
    autofocus: autofocus ? 'end' : false,
    editorProps: { attributes: { class: 'prose-oats min-h-[40vh] pb-40' } },
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? '' : editor.getHTML())
  })

  useEffect(() => {
    if (editor && onReady) onReady(editor)
  }, [editor, onReady])

  // Accept external replacements (e.g. a regenerated panel) without clobbering typing.
  useEffect(() => {
    if (!editor || editor.isFocused) return
    if (editor.getHTML() !== html) editor.commands.setContent(html, { emitUpdate: false })
  }, [editor, html])

  return (
    <div {...mentionCard.handlers}>
      <EditorContent editor={editor} />
      {mentionCard.card}
    </div>
  )
}
