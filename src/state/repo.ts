import { db } from '../db/db';
import { Repo } from '../db/repo';
import { PdfRepo } from '../pdf/repo';

export const repo = new Repo(db);
export const pdfRepo = new PdfRepo(db);
