import { Seo } from '@/components/Seo'
import { seo } from '@/seo'
import { ArrowRight, CalendarDays, MessageCircle, Users } from 'lucide-react'

export default function Home() {
  return <main data-testid="static-landing" className="min-h-screen bg-[#0b110f] text-white">
    <Seo {...seo} path="/" />
    <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-7 sm:px-10">
      <a href="/" className="text-xl font-black tracking-[-0.055em]">rally<span className="text-[#d7fc83]">circle</span><span className="text-[#d7fc83]">.</span></a>
      <a href="/rallies" className="rounded-full border border-white/20 px-5 py-2.5 text-xs font-bold transition hover:border-[#d7fc83]">Open app →</a>
    </header>
    <div className="mx-auto grid max-w-7xl items-center gap-12 px-6 pb-24 pt-10 sm:px-10 lg:grid-cols-2 lg:py-24">
      <div>
        <p className="mb-5 text-xs font-extrabold uppercase tracking-[0.27em] text-[#d7fc83]">More tennis. Less organizing.</p>
        <h1 className="max-w-2xl text-6xl font-black leading-[0.98] tracking-[-0.075em] sm:text-7xl lg:text-8xl">Your next <span className="text-[#d7fc83]">rally</span> starts here.</h1>
        <p className="mt-7 max-w-lg text-lg leading-relaxed text-white/60">Create a session, find hitting partners and keep everyone on the same court. Real-time RSVPs and a conversation for every rally.</p>
        <a href="/rallies" className="mt-9 inline-flex items-center gap-3 rounded-xl bg-[#d7fc83] px-6 py-4 text-sm font-extrabold text-[#101a13] transition hover:bg-[#e9ffb3]">Find a session <ArrowRight size={18}/></a>
        <div className="mt-12 grid max-w-lg grid-cols-3 gap-4 border-t border-white/10 pt-6 text-xs text-white/60"><span className="flex flex-col gap-2"><CalendarDays size={20} className="text-[#d7fc83]"/>Plan sessions</span><span className="flex flex-col gap-2"><Users size={20} className="text-[#d7fc83]"/>Live attendance</span><span className="flex flex-col gap-2"><MessageCircle size={20} className="text-[#d7fc83]"/>Group chat</span></div>
      </div>
      <div aria-label="Illustrated tennis court" role="img" className="relative mx-auto aspect-square w-full max-w-[590px] overflow-hidden rounded-[2rem] border border-white/10 bg-[#224934] p-8 shadow-[0_30px_100px_rgba(0,0,0,.35)]">
        <div className="absolute inset-0 opacity-60" style={{background:'radial-gradient(circle at 25% 22%, #76a05f 0%, transparent 45%), linear-gradient(135deg, #1c4b3b, #172e23)'}}/>
        <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full border-[50px] border-[#d7fc83]/10"/>
        <div className="relative flex h-full w-full items-center justify-center rounded-lg border-4 border-[#f7ffeb]/70 bg-[#326c53] shadow-inner">
          <div className="absolute inset-y-0 left-[19%] w-px bg-white/60"/><div className="absolute inset-y-0 right-[19%] w-px bg-white/60"/>
          <div className="absolute left-0 right-0 top-1/2 h-[3px] bg-white/90"/>
          <div className="absolute left-[19%] right-[19%] top-[25%] h-px bg-white/60"/><div className="absolute left-[19%] right-[19%] bottom-[25%] h-px bg-white/60"/>
          <div className="absolute inset-y-[25%] left-1/2 w-px bg-white/55"/>
          <div className="absolute left-[27%] top-[15%] grid h-11 w-11 place-items-center rounded-full bg-[#d7fc83] text-2xl shadow-xl">●</div><div className="absolute bottom-[17%] right-[29%] h-8 w-8 rounded-full bg-white shadow-xl"/>
          <div className="absolute bottom-6 left-6 rounded-xl border border-white/20 bg-[#0e1c15]/85 px-4 py-3 backdrop-blur"><p className="text-[10px] font-bold uppercase tracking-widest text-[#d7fc83]">Live session</p><p className="mt-1 text-sm font-bold">Sunday doubles</p><p className="mt-1 text-xs text-white/65">4 players · 10:00 AM</p></div>
        </div>
      </div>
    </div>
  </main>
}
