import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSupplierReplyDataset, verifySupplierReplyDataset } from '../../packages/evals/src/supplier-replies/dataset.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const datasetPath = resolve(repositoryRoot, 'evals/supplier-replies/v1/dataset.jsonl');
const digestPath = resolve(repositoryRoot, 'evals/supplier-replies/v1/dataset.sha256');

const { cases, sourceBytes } = await loadSupplierReplyDataset(datasetPath);
const expectedDigest = (await readFile(digestPath, 'utf8')).trim();
const result = verifySupplierReplyDataset(cases, sourceBytes, { expectedDigest });
console.log(`cases=${result.caseCount} digest=${result.digest} privacy=${result.privacy} schema=${result.schema} labels=${result.labels}`);
