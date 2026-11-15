// Finds member photo files that no member row points to (e.g. an old photo whose deletion
// failed after it was replaced) and, with --delete, removes them. Files younger than an hour
// are left alone so an upload in progress is never touched. Read-only without --delete.
// Usage: npm run sweep:photos            (list only)
//        npm run sweep:photos -- --delete
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { PHOTO_BUCKET } from "../services/memberPhotosService.js";

const PAGE_SIZE = 1000;
const MIN_AGE_MS = 60 * 60 * 1000;

async function listFolder(storage, prefix) {
    const entries = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error } = await storage.list(prefix, { limit: PAGE_SIZE, offset });
        if (error) throw new Error(`Could not list ${prefix || "the bucket"}: ${error.message}`);
        entries.push(...data);
        if (data.length < PAGE_SIZE) return entries;
    }
}

async function main() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env.");
    }
    const remove = process.argv.includes("--delete");
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const referenced = new Set();
    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await client.from("members").select("photo_path").not("photo_path", "is", null)
            .order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`Could not read members: ${error.message}`);
        data.forEach((row) => referenced.add(row.photo_path));
        if (data.length < PAGE_SIZE) break;
    }
    const storage = client.storage.from(PHOTO_BUCKET);
    const orphans = [];
    for (const gym of await listFolder(storage, "")) {
        for (const member of await listFolder(storage, gym.name)) {
            for (const file of await listFolder(storage, `${gym.name}/${member.name}`)) {
                const path = `${gym.name}/${member.name}/${file.name}`;
                const age = Date.now() - Date.parse(file.created_at || 0);
                if (!referenced.has(path) && age > MIN_AGE_MS) orphans.push(path);
            }
        }
    }
    console.log(`${referenced.size} photos in use; ${orphans.length} unreferenced file(s).`);
    orphans.forEach((path) => console.log(path));
    if (remove && orphans.length) {
        for (let index = 0; index < orphans.length; index += 100) {
            const { error } = await storage.remove(orphans.slice(index, index + 100));
            if (error) throw new Error(`Could not delete files: ${error.message}`);
        }
        console.log(`Deleted ${orphans.length} file(s).`);
    } else if (orphans.length) {
        console.log("Run again with --delete to remove them.");
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
