import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { MeetingPill } from './components/MeetingPill'
import './styles.css'

// The same bundle renders the floating "meeting detected" window (main/pill.ts).
const isPill = location.hash === '#pill'
if (isPill) document.documentElement.classList.add('pill')

createRoot(document.getElementById('root')!).render(<StrictMode>{isPill ? <MeetingPill /> : <App />}</StrictMode>)
