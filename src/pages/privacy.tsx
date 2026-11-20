import { Seo } from '@/components/Seo'
import { seo } from '@/seo'
import './landing.css'

export default function PrivacyPage() {
  return (
    <main className="tennis-landing">
      <Seo {...seo} title="Privacy and help | RallyCircle" path="/privacy" />
      <header className="tennis-frame tennis-header"><a href="/" className="tennis-wordmark">RallyCircle</a></header>
      <article className="tennis-frame max-w-3xl space-y-7 py-12 leading-relaxed">
        <h1 className="font-serif text-4xl">Privacy and help</h1>
        <section><h2 className="text-xl font-bold">Sessions and messages</h2><p>Signed-in members can browse rally details and session chat. Share court details and logistics you are comfortable sharing with other members. A rally invitation opens the session after sign-in.</p></section>
        <section><h2 className="text-xl font-bold">Location and court searches</h2><p>Nearby search requests your location only after you choose that option. An approximate location is sent to the court search service. You can search by city or place instead. Court listings do not indicate booking availability.</p></section>
        <section><h2 className="text-xl font-bold">RSVPs and waitlists</h2><p>If a rally is full, use its waitlist. When a place opens, the next queued player can be confirmed automatically. Check the rally for your current status.</p></section>
        <a className="tennis-secondary" href="/games">Find a game</a>
      </article>
    </main>
  )
}
