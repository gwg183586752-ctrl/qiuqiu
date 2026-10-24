import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const filename = 'public/models/VRM1_Constraint_Twist_Sample.vrm';
const data = readFileSync(filename);
if (data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) throw new Error('VRM/GLB 文件不完整');
const length = data.readUInt32LE(12);
const document = JSON.parse(data.toString('utf8', 20, 20 + length).trim());
const vrm = document.extensions?.VRMC_vrm;
if (!vrm?.meta || !vrm.humanoid?.humanBones) throw new Error('缺少 VRM 元数据或人形骨骼');
const report = {
  source: 'https://github.com/vrm-c/vrm-specification/tree/master/samples/VRM1_Constraint_Twist_Sample',
  download: 'https://raw.githubusercontent.com/vrm-c/vrm-specification/master/samples/VRM1_Constraint_Twist_Sample/vrm/VRM1_Constraint_Twist_Sample.vrm',
  bytes: data.length,
  sha256: createHash('sha256').update(data).digest('hex'),
  meta: vrm.meta,
  expressions: Object.keys(vrm.expressions?.preset ?? {}),
  humanBones: Object.keys(vrm.humanoid.humanBones),
};
if (process.argv.includes('--write-license')) writeFileSync('public/models/model-license.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
