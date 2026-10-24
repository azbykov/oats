import { Extension } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'

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

export function NoteEditor({
  html,
  placeholder,
  onChange,
  autofocus,
  onReady
}: {
  html: string
  placeholder: string
  onChange: (html: string) => void
  autofocus?: boolean
  onReady?: (editor: Editor) => void
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder }),
      AuthorshipClass
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

  return <EditorContent editor={editor} />
}
