// Offline SVG rasterization through the same renderer used by the browser.
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '../packages/mini/node_modules/playwright-core/index.mjs';
const jobs=JSON.parse(process.argv[2]);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/snap/bin/chromium',headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage();
 for(const job of jobs){
  const svg=await readFile(job.source,'utf8');
  const data=await page.evaluate(async({svg,size})=>{
   const image=new Image();
   const ready=new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('SVG decode failed'));});
   image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await ready;
   const scale=4,large=document.createElement('canvas');large.width=large.height=size*scale;
   large.getContext('2d').drawImage(image,0,0,large.width,large.height);
   const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
   const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(large,0,0,size,size);
   return canvas.toDataURL('image/png').split(',')[1];
  },{svg,size:job.size});
  await writeFile(job.output,Buffer.from(data,'base64'));
 }
}finally{await browser.close();}
