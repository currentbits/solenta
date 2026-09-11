import { AbsoluteFill, Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { Audio } from '@remotion/media';
import type { CSSProperties, ReactNode } from 'react';

const BACKGROUND = '#11151c', TEXT = '#e1e7f0', ACCENT = '#537cb5';
const ease = Easing.bezier(.16, 1, .3, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

function Reveal({ children, delay = 0, style = {} }: { children: ReactNode; delay?: number; style?: CSSProperties }) {
  const f = useCurrentFrame();
  return <div style={{ ...style, opacity: interpolate(f, [delay, delay + 13], [0, 1], clamp), translate: `0 ${interpolate(f, [delay, delay + 23], [42, 0], { ...clamp, easing: ease })}px` }}>{children}</div>;
}
function Marker({ children, delay = 8 }: { children: ReactNode; delay?: number }) {
  const f = useCurrentFrame();
  return <span style={{ position: 'relative', isolation: 'isolate', whiteSpace: 'nowrap' }}>
    <span style={{ position: 'absolute', inset: 'auto 0 -.02em', height: '.045em', background: ACCENT, zIndex: -1, transformOrigin: 'left', scale: `${interpolate(f, [delay, delay + 17], [0, 1], { ...clamp, easing: ease })} 1` }} />{children}
  </span>;
}
function Brand({ prominent = false }: { prominent?: boolean }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: prominent ? 22 : 13, fontSize: prominent ? 52 : 31, letterSpacing: -1.2, fontWeight: 650 }}>
    <Img src={staticFile('solenta-logo.svg')} style={{ width: prominent ? 100 : 54, height: prominent ? 100 : 54 }} />solenta
  </div>;
}
function Chrome({ children, chapter = '', prominentBrand = false }: { children: ReactNode; chapter?: string; prominentBrand?: boolean }) {
  return <AbsoluteFill style={{ background: BACKGROUND, color: TEXT, fontFamily: FONT, overflow: 'hidden' }}>
    <div style={{ position: 'absolute', inset: '37px 66px auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 20 }}><Brand prominent={prominentBrand} /><span style={{ fontSize: 17, fontWeight: 500, letterSpacing: 2, color: '#8c9aaf' }}>{chapter}</span></div>
    {children}
  </AbsoluteFill>;
}
// Fresh Electron captures of the installed Nightly distribution, unchanged UI.
function Shot({ file, style }: { file: string; style?: CSSProperties }) {
  return <div style={{ borderRadius: 10, overflow: 'hidden', background: '#0a0d13', border: '1px solid #2b3545', ...style }}>
    <Img src={staticFile(`captures/${file}.png`)} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }} />
  </div>;
}
function Footer({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 31, lineHeight: 1.3, letterSpacing: -.4, color: '#a0adbf' }}>{children}</div>;
}
function Opening() {
  return <Chrome>
    <Sequence durationInFrames={108}>
      <Reveal delay={-8} style={{position:'absolute',left:345,top:43}}><h1 style={{fontSize:52,letterSpacing:-2.2,fontWeight:550,margin:0}}>Your coding agents. <Marker>One workspace.</Marker></h1></Reveal>
    </Sequence>
    <Sequence from={108} durationInFrames={108}>
      <Reveal delay={-8} style={{position:'absolute',left:345,top:43}}><h1 style={{fontSize:52,letterSpacing:-2.2,fontWeight:550,margin:0}}>Shared context. <Marker>Less starting over.</Marker></h1></Reveal>
    </Sequence>
    <Shot file="overview" style={{position:'absolute',left:48,top:140,width:1504,height:836}} />
  </Chrome>;
}
const chapters = [
  { from:216, duration:144, num:'01', label:'START WITH YOUR PROJECT', title:<>Your project.<br /><Marker>Your prompt.</Marker></>, note:'Open a repo. Describe what you want.', file:'composer' },
  { from:360, duration:180, num:'02', label:'CHOOSE YOUR AGENT', title:<>Claude. Codex. Grok.<br /><Marker>Your choice.</Marker></>, note:'Run the coding agents you already use.', file:'providers' },
  { from:540, duration:216, num:'03', label:'SHARE WHAT YOU LEARN', title:<>New agent.<br /><Marker>Same memory.</Marker></>, note:'Conventions. Decisions. Project context.', file:'memory' },
  { from:756, duration:216, num:'04', label:'BUILD IN PARALLEL', title:<>One task.<br /><Marker>A team of agents.</Marker></>, note:'Separate worktrees. Shared context.', file:'workers' },
  { from:972, duration:216, num:'05', label:'REVIEW THE RESULT', title:<>See the diff.<br /><Marker>Make the call.</Marker></>, note:'Review changes. Run checks. Merge when ready.', file:'git' },
];
function ProductScene({ num, label, title, note, file, duration }: typeof chapters[number]) {
  const f=useCurrentFrame();
  const split = file === 'memory' || file === 'providers' || file === 'workers';
  if(file==='composer') return <Chrome>
    <Reveal delay={-8} style={{position:'absolute',left:345,top:43}}><h1 style={{fontSize:52,letterSpacing:-2.2,fontWeight:550,margin:0}}>Open a repo. <Marker>Describe the work.</Marker></h1></Reveal>
    <Shot file="composer" style={{position:'absolute',left:48,top:140,width:1504,height:836}} />
  </Chrome>;
  return <Chrome chapter={`${num} / ${label}`}>
    {split ? <div style={{display:'grid',gridTemplateColumns:'620px 1fr',gap:38,padding:'166px 72px 85px',height:'100%',alignItems:'center'}}>
      <div style={{display:'flex',flexDirection:'column',gap:40}}><Reveal><h1 style={{fontSize:79,letterSpacing:-4,lineHeight:1.06,fontWeight:550,margin:0}}>{title}</h1></Reveal><Reveal delay={13}><Footer>{note}</Footer></Reveal></div>
      <Reveal delay={5} style={{height:file==='memory'?750:540,width:file==='memory'?600:'100%',justifySelf:'center'}}><Shot file={file} style={{width:'100%',height:'100%'}}/></Reveal>
    </div> : <div style={{display:'flex',flexDirection:'column',padding:'134px 72px 50px',height:'100%',gap:27}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:45}}><Reveal><h1 style={{fontSize:73,letterSpacing:-3.6,lineHeight:1.03,fontWeight:550,margin:0}}>{title}</h1></Reveal><Reveal delay={13} style={{maxWidth:500,paddingBottom:5}}><Footer>{note}</Footer></Reveal></div>
      <Reveal delay={5} style={{flex:1,minHeight:0}}><Shot file={file} style={{width:'100%',height:'100%'}}/></Reveal>
    </div>}
    <div style={{position:'absolute',left:0,bottom:0,width:interpolate(f,[0,duration-1],[0,1600],clamp),height:2,background:ACCENT}} />
  </Chrome>;
}
function Remember() {
  const f=useCurrentFrame();
  return <Chrome chapter="CONTEXT THAT CARRIES FORWARD">
    <div style={{height:'100%',display:'flex',flexDirection:'column',justifyContent:'center',padding:'0 106px',gap:47}}>
      <Reveal><h1 style={{fontSize:111,fontWeight:550,lineHeight:1.05,letterSpacing:-6,margin:0}}>Every agent starts<br />where the last<br /><Marker>one stopped.</Marker></h1></Reveal>
      <Reveal delay={15}><div style={{display:'flex',gap:32,alignItems:'center',fontSize:29,color:'#a0adbf'}}><span>Shared local memory</span><span style={{width:interpolate(f,[20,48],[0,135],{...clamp,easing:ease}),height:2,background:ACCENT}}/><span>Across sessions and agents</span></div></Reveal>
    </div>
  </Chrome>;
}
function End() {
  return <Chrome chapter="YOUR NEXT SESSION STARTS HERE">
    <div style={{display:'flex',height:'100%',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:40,paddingBottom:4}}>
      <Reveal><div style={{display:'flex',alignItems:'center',gap:38,fontSize:172,fontWeight:550,letterSpacing:-10,lineHeight:1.1}}><Img src={staticFile('solenta-logo.svg')} style={{width:210,height:210}} />solenta</div></Reveal>
      <Reveal delay={9}><div style={{fontSize:43,letterSpacing:-1.3}}>Your agents. One workspace. Shared memory.</div></Reveal>
      <Reveal delay={18} style={{marginTop:14}}><div style={{padding:'20px 43px 23px',background:'#223655',border:'1px solid #45658f',borderRadius:8,fontSize:47,fontWeight:500,letterSpacing:-1.3,display:'flex',alignItems:'center',gap:46}}>solenta.app <span style={{fontSize:48}}>↗</span></div></Reveal>
      <Reveal delay={25}><div style={{fontSize:23,color:'#8c9aaf',letterSpacing:.4}}>macOS · Windows · Linux &nbsp; / &nbsp; Open source</div></Reveal>
    </div>
  </Chrome>;
}
export function Film() {
  return <AbsoluteFill style={{background:BACKGROUND}}>
    <Audio src={staticFile('score.wav')} />
    <Sequence durationInFrames={216}><Opening /></Sequence>
    {chapters.map(c=><Sequence key={c.num} from={c.from} durationInFrames={c.duration}><ProductScene {...c}/></Sequence>)}
    <Sequence from={1188} durationInFrames={108}><Remember /></Sequence>
    <Sequence from={1296} durationInFrames={144}><End /></Sequence>
  </AbsoluteFill>;
}
