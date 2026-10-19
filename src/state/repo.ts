import { db } from '../db/db';
import { Repo } from '../db/repo';

export const repo = new Repo(db);
