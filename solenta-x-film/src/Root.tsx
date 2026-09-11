import './index.css';
import { Composition } from 'remotion';
import { Film } from './Composition';

export const RemotionRoot = () => <Composition id="Solenta" component={Film} durationInFrames={1440} fps={30} width={1600} height={1000} />;
