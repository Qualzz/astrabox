import { mkdir, writeFile } from "node:fs/promises";
import { encodeMidi, decodeMidi } from "../src/midi.js";

// Petite orbite — original ASTRABOX menu theme. 16 bars, C major, 92 BPM.
// A question/answer melody, softly syncopated broken chords, rounded bass.
// Deliberate gaps keep it airy; the last G resolves on the next loop's C.
const melody = [
  [[0,76,.75],[1,79,.45],[1.5,83,.9],[3,81,.55]],
  [[0,79,1.3],[2,76,.65],[3,74,.45]],
  [[.5,72,.7],[1.5,76,.45],[2,79,.85],[3.25,76,.5]],
  [[0,77,1.25],[2,76,.55],[3,72,.65]],
  [[0,74,.8],[1.5,77,.45],[2,81,.85],[3.5,79,.35]],
  [[0,76,1.1],[2,74,.65],[3,71,.5]],
  [[0,72,.65],[1,76,.45],[1.75,77,.75],[3,76,.5]],
  [[0,74,1.5],[2.5,79,.7]],
  [[0,76,.55],[.75,79,.55],[1.5,84,1.1],[3,83,.65]],
  [[0,79,1],[1.5,76,.45],[2.5,74,.9]],
  [[0,76,.7],[1,79,.45],[1.75,81,.9],[3.25,79,.45]],
  [[0,77,1.4],[2,76,.55],[3,72,.6]],
  [[0,74,.75],[1.5,77,.45],[2,81,.8],[3.25,84,.5]],
  [[0,83,.65],[1,79,.65],[2.5,76,.85]],
  [[0,77,.7],[1,76,.55],[2,72,1.1]],
  [[0,74,.7],[1.25,71,.75],[2.5,67,.75]],
];
const harmony = [[48,55,59,64],[40,55,59,62],[45,55,60,64],[41,57,60,64],
  [38,57,60,64],[40,55,59,62],[41,57,60,64],[43,55,59,64]];
const lead = [], bass = [], pluck = [];
for (let bar = 0; bar < 16; bar++) {
  for (const [beat, pitch, duration] of melody[bar]) lead.push([bar * 4 + beat, pitch, duration, beat === 0 ? 78 : 66]);
  const [root, ...chord] = harmony[bar % 8];
  bass.push([bar * 4, root, 1.65, 68], [bar * 4 + 2.5, root + 7, .8, 47]);
  for (const [i, beat] of [.5, 1.5, 2.5, 3.5].entries()) pluck.push([bar * 4 + beat, chord[i % 3], .36, i % 2 ? 34 : 42]);
}
const midi = encodeMidi({ bpm: 92, beats: 64, tracks: [
  { channel: 0, program: 10, notes: lead },
  { channel: 1, program: 33, notes: bass },
  { channel: 2, program: 4, notes: pluck },
] });
const destination = new URL("../assets/audio/music/", import.meta.url);
await mkdir(destination, { recursive: true });
await writeFile(new URL("petite-orbite.mid", destination), midi);
console.log(`Petite orbite: ${midi.length} bytes, ${decodeMidi(midi).duration.toFixed(2)} s, 16 bars.`);
