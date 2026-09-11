import { bundle } from '@remotion/bundler';
import { selectComposition, renderStill } from '@remotion/renderer';
import path from 'node:path';
const serveUrl = await bundle({entryPoint:path.resolve('src/index.ts')});
const composition=await selectComposition({serveUrl,id:'Solenta'});
for(const frame of [50,166,288,438,640,855,1070,1240,1370]) {
  await renderStill({serveUrl,composition,frame,output:`out/scene-${frame}.png`});
  console.log(`Preview ${frame}`);
}
