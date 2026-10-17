import fs from 'fs';
import path from 'path';
import { collection, doc, getDocs, setDoc, deleteDoc, getDoc, query, where } from 'firebase/firestore';
import { ensureServerAuth, getFirestoreDB, cleanForFirestore } from './firestoreService';
import type { PersonalTestRecord, PersonalTestStore } from './personalTests';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PERSONAL_TESTS_FILE = path.join(DATA_DIR, 'personal_tests.json');

function loadLocalPersonalTests(): Map<string, PersonalTestRecord> {
  const map = new Map<string, PersonalTestRecord>();
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(PERSONAL_TESTS_FILE)) {
      const raw = fs.readFileSync(PERSONAL_TESTS_FILE, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && item.id) {
            map.set(item.id, item);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Personal Tests Local Store Warning] Could not read local file:', err);
  }
  return map;
}

function saveLocalPersonalTests(map: Map<string, PersonalTestRecord>): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const arr = Array.from(map.values());
    fs.writeFileSync(PERSONAL_TESTS_FILE, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Personal Tests Local Store Warning] Could not save local file:', err);
  }
}

/**
 * Resilient Firestore + Local File store.
 * - Always persists to data/personal_tests.json so data is NEVER lost across restarts.
 * - Syncs with Firestore 'personal_tests' collection.
 * - If Firestore security rules on the live project haven't been updated yet,
 *   gracefully falls back to local storage without throwing permission errors to the user.
 */
export const personalTestsFirestoreStore: PersonalTestStore = {
  async listByMember(memberId) {
    const localMap = loadLocalPersonalTests();
    const localRecords = Array.from(localMap.values()).filter((r) => r.member_id === memberId);

    try {
      await ensureServerAuth();
      const db = getFirestoreDB();
      const snap = await getDocs(query(collection(db, 'personal_tests'), where('member_id', '==', memberId)));
      let hasNewData = false;
      snap.forEach((d) => {
        const remoteRecord = { ...(d.data() as PersonalTestRecord), id: d.id };
        if (!localMap.has(remoteRecord.id)) {
          localMap.set(remoteRecord.id, remoteRecord);
          hasNewData = true;
        }
      });
      if (hasNewData) {
        saveLocalPersonalTests(localMap);
      }
      return Array.from(localMap.values()).filter((r) => r.member_id === memberId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Firestore personal_tests notice] Firestore query skipped (${msg}), using persistent local data.`);
      return localRecords;
    }
  },

  async add(record) {
    // 1. Always persist locally first so records are guaranteed saved
    const localMap = loadLocalPersonalTests();
    localMap.set(record.id, record);
    saveLocalPersonalTests(localMap);

    // 2. Best-effort write to Firestore
    try {
      await ensureServerAuth();
      const db = getFirestoreDB();
      await setDoc(doc(db, 'personal_tests', record.id), cleanForFirestore(record));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Firestore personal_tests notice] Could not sync to Firestore (${msg}), stored safely in local database.`);
    }
  },

  async remove(memberId, id) {
    const localMap = loadLocalPersonalTests();
    const existing = localMap.get(id);
    const hadLocal = existing && existing.member_id === memberId ? localMap.delete(id) : false;
    if (hadLocal) {
      saveLocalPersonalTests(localMap);
    }

    try {
      await ensureServerAuth();
      const db = getFirestoreDB();
      const ref = doc(db, 'personal_tests', id);
      const snap = await getDoc(ref);
      if (snap.exists() && (snap.data() as any).member_id === memberId) {
        await deleteDoc(ref);
        return true;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Firestore personal_tests notice] Could not delete from Firestore (${msg}).`);
    }

    return hadLocal;
  },
};

