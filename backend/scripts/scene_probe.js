// Diagnostic: validates the ORB scene-matching pipeline with synthetic scenes.
// Same scene rotated 15° must confirm; two unrelated scenes must not.
import sharp from 'sharp';
import { extractFeatures, matchFeatures } from '../src/services/scene.js';

const rand = (n) => Math.floor(Math.random() * n);
function sceneSvg(w = 640, h = 480) {
  let shapes = '';
  for (let i = 0; i < 40; i++) {
    shapes += `<rect x="${rand(w)}" y="${rand(h)}" width="${20 + rand(120)}" height="${20 + rand(120)}"
      fill="rgb(${rand(255)},${rand(255)},${rand(255)})"/>`;
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <rect width="100%" height="100%" fill="#8a8a8a"/>${shapes}</svg>`,
  );
}

const A = await sharp(sceneSvg()).jpeg().toBuffer();
const A2 = await sharp(A).rotate(15).jpeg().toBuffer();
const B = await sharp(sceneSvg()).jpeg().toBuffer();

const [fA, fA2, fB] = [await extractFeatures(A), await extractFeatures(A2), await extractFeatures(B)];
console.log('features extracted:', !!fA, !!fA2, !!fB);
console.log('same scene rotated:', await matchFeatures(fA, fA2));
console.log('unrelated scenes  :', await matchFeatures(fA, fB));
