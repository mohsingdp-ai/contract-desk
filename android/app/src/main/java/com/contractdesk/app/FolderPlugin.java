package com.contractdesk.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.security.MessageDigest;
import org.json.JSONObject;

/**
 * The data folder (decision-2): "All files access" and the system folder picker, plus the few file operations the
 * app needs there. A folder is either a plain path (All files access on) or a content:// tree link from the picker
 * (permission refused). Names are relative to the folder, e.g. "contracts.db" or "files/<uuid>.pdf".
 * Reading is not here: the WebView streams files itself (fetch of Capacitor.convertFileSrc).
 */
@CapacitorPlugin(name = "Folder")
public class FolderPlugin extends Plugin {

    private static final String STORAGE = "com.android.externalstorage.documents";

    @PluginMethod
    public void hasAllFilesAccess(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", Environment.isExternalStorageManager());
        call.resolve(r);
    }

    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
        startActivityForResult(call, i, "accessResult");
    }

    @ActivityCallback
    private void accessResult(PluginCall call, ActivityResult result) {
        hasAllFilesAccess(call);
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUri(STORAGE, "primary:Documents"));
        i.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        startActivityForResult(call, i, "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        Uri tree = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || tree == null) {
            call.resolve(new JSObject()); // cancelled
            return;
        }
        if (!STORAGE.equals(tree.getAuthority())) {
            call.reject("Choose a folder on the phone's own storage (for example in Documents).");
            return;
        }
        int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        getContext().getContentResolver().takePersistableUriPermission(tree, flags);
        // "primary:Documents/X" -> /storage/emulated/0/Documents/X; other volumes -> /storage/<id>/X
        String[] id = DocumentsContract.getTreeDocumentId(tree).split(":", 2);
        String root = "primary".equals(id[0]) ? Environment.getExternalStorageDirectory().getPath() : "/storage/" + id[0];
        JSObject r = new JSObject();
        r.put("uri", tree.toString());
        r.put("path", id.length > 1 && !id[1].isEmpty() ? root + "/" + id[1] : root);
        call.resolve(r);
    }

    // ---------- file operations (folder = path or tree link) ----------

    private ContentResolver cr() {
        return getContext().getContentResolver();
    }

    private static boolean isTree(String folder) {
        return folder.startsWith("content://");
    }

    // Android's storage provider names a child document "<parent id>/<name>".
    private static Uri doc(String tree, String name) {
        Uri t = Uri.parse(tree);
        String id = DocumentsContract.getTreeDocumentId(t);
        return DocumentsContract.buildDocumentUriUsingTree(t, name.isEmpty() ? id : id + "/" + name);
    }

    private boolean treeExists(String tree, String name) {
        try (Cursor c = cr().query(doc(tree, name), new String[] { Document.COLUMN_DOCUMENT_ID }, null, null, null)) {
            return c != null && c.moveToFirst();
        } catch (Exception e) {
            return false;
        }
    }

    // Creates the document (and a missing "files" folder) if needed.
    private Uri treeCreate(String tree, String name) throws IOException {
        if (treeExists(tree, name)) return doc(tree, name);
        int slash = name.lastIndexOf('/');
        String dir = slash < 0 ? "" : name.substring(0, slash);
        if (!dir.isEmpty() && !treeExists(tree, dir)) treeCreateDir(tree, dir);
        Uri made = DocumentsContract.createDocument(cr(), doc(tree, dir), "application/octet-stream", name.substring(slash + 1));
        if (made == null) throw new IOException("Could not create " + name);
        return made;
    }

    private void treeCreateDir(String tree, String dir) throws IOException {
        if (DocumentsContract.createDocument(cr(), doc(tree, ""), Document.MIME_TYPE_DIR, dir) == null) {
            throw new IOException("Could not create folder " + dir);
        }
    }

    private OutputStream openOut(String folder, String name, boolean append) throws IOException {
        if (isTree(folder)) {
            OutputStream out = cr().openOutputStream(treeCreate(folder, name), append ? "wa" : "wt");
            if (out == null) throw new IOException("Could not write " + name);
            return out;
        }
        File f = new File(folder, name);
        File parent = f.getParentFile();
        if (parent != null) parent.mkdirs();
        return new FileOutputStream(f, append);
    }

    private InputStream openIn(String folder, String name) throws IOException {
        if (isTree(folder)) {
            InputStream in = cr().openInputStream(doc(folder, name));
            if (in == null) throw new FileNotFoundException(name);
            return in;
        }
        return new FileInputStream(new File(folder, name));
    }

    @PluginMethod
    public void prepare(PluginCall call) {
        String folder = call.getString("folder");
        try {
            if (isTree(folder)) {
                if (!treeExists(folder, "")) throw new IOException("The folder is no longer available. Choose it again.");
                if (!treeExists(folder, "files")) treeCreateDir(folder, "files");
            } else {
                File files = new File(folder, "files");
                if (!files.isDirectory() && !files.mkdirs()) throw new IOException("Could not create " + files.getPath());
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stat(PluginCall call) {
        String folder = call.getString("folder");
        String name = call.getString("name");
        JSObject r = new JSObject();
        if (isTree(folder)) {
            String[] cols = { Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED };
            try (Cursor c = cr().query(doc(folder, name), cols, null, null, null)) {
                boolean found = c != null && c.moveToFirst();
                r.put("exists", found);
                r.put("size", found ? c.getLong(0) : 0);
                r.put("mtime", found ? c.getLong(1) : 0);
            } catch (Exception e) {
                r.put("exists", false);
            }
        } else {
            File f = new File(folder, name);
            r.put("exists", f.isFile());
            r.put("size", f.length());
            r.put("mtime", f.lastModified());
        }
        call.resolve(r);
    }

    // One piece of a file, base64 (callers send 4 MB pieces; one whole-file call crashes on big files, decision-1).
    @PluginMethod
    public void write(PluginCall call) {
        try (OutputStream out = openOut(call.getString("folder"), call.getString("name"), call.getBoolean("append", false))) {
            out.write(Base64.decode(call.getString("data"), Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    // Replaces "to" with "from" (also into another sub-folder, e.g. a restored file from ".restore/x" to "files/x").
    // Plain paths: one atomic rename. Picker links can't rename over a file, so the old one is deleted first; a crash in
    // between leaves only the .tmp, which start-up recovers.
    @PluginMethod
    public void rename(PluginCall call) {
        String folder = call.getString("folder");
        String from = call.getString("from");
        String to = call.getString("to");
        try {
            if (isTree(folder)) {
                if (treeExists(folder, to)) DocumentsContract.deleteDocument(cr(), doc(folder, to));
                Uri src = doc(folder, from);
                if (!dirOf(from).equals(dirOf(to))) {
                    src = DocumentsContract.moveDocument(cr(), src, doc(folder, dirOf(from)), doc(folder, dirOf(to)));
                    if (src == null) throw new IOException("Could not move " + from);
                }
                String name = to.substring(to.lastIndexOf('/') + 1);
                if (!from.endsWith("/" + name) && !from.equals(name) && DocumentsContract.renameDocument(cr(), src, name) == null) {
                    throw new IOException("Could not rename " + from);
                }
            } else if (!new File(folder, from).renameTo(new File(folder, to))) {
                throw new IOException("Could not rename " + from + " to " + to);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    private static String dirOf(String name) {
        int slash = name.lastIndexOf('/');
        return slash < 0 ? "" : name.substring(0, slash);
    }

    // A file, or a folder with everything in it (a picker link's folder is deleted with its contents by Android).
    @PluginMethod
    public void remove(PluginCall call) {
        String folder = call.getString("folder");
        String name = call.getString("name");
        try {
            if (isTree(folder)) {
                if (treeExists(folder, name)) DocumentsContract.deleteDocument(cr(), doc(folder, name));
            } else {
                File f = new File(folder, name);
                File[] inside = f.listFiles();
                if (inside != null) for (File c : inside) c.delete(); // one level: what the app puts in a folder it removes
                if (f.exists() && !f.delete()) throw new IOException("Could not delete " + name);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    // File names in a sub-folder (e.g. "files").
    @PluginMethod
    public void list(PluginCall call) {
        String folder = call.getString("folder");
        String dir = call.getString("dir");
        JSArray names = new JSArray();
        if (isTree(folder)) {
            Uri t = Uri.parse(folder);
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(t, DocumentsContract.getTreeDocumentId(t) + "/" + dir);
            try (Cursor c = cr().query(children, new String[] { Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
                while (c != null && c.moveToNext()) names.put(c.getString(0));
            } catch (Exception e) {
                // missing folder: no names
            }
        } else {
            String[] found = new File(folder, dir).list();
            if (found != null) for (String n : found) names.put(n);
        }
        JSObject r = new JSObject();
        r.put("names", names);
        call.resolve(r);
    }

    // Free bytes on the storage that holds the folder (its plain path, also in picker mode). Without All files access the
    // path may not be readable (0): the phone's own storage is then used, which is where Documents lives.
    @PluginMethod
    public void freeSpace(PluginCall call) {
        long free = new File(call.getString("path")).getUsableSpace();
        if (free == 0) free = Environment.getDataDirectory().getUsableSpace();
        JSObject r = new JSObject();
        r.put("free", free);
        call.resolve(r);
    }

    // Copies one file between data folders (moving records to a new folder). Returns the bytes copied.
    @PluginMethod
    public void copy(PluginCall call) {
        String name = call.getString("name");
        try (InputStream in = openIn(call.getString("from"), name); OutputStream out = openOut(call.getString("to"), name, false)) {
            JSObject r = new JSObject();
            r.put("bytes", pump(in, out));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    // Where a file is written before it is shared (an Excel export): the app's cache folder. No permission needed,
    // and Android clears it by itself.
    @PluginMethod
    public void cacheFolder(PluginCall call) {
        JSObject r = new JSObject();
        r.put("path", getContext().getCacheDir().getPath());
        call.resolve(r);
    }

    // ---------- backup (format in core/backup.js; the app sends the small parts, the files never cross the bridge) ----------

    // Size and SHA-256 of each named file in a folder, in order; { exists: false } for a missing one.
    @PluginMethod
    public void hashFiles(PluginCall call) {
        String folder = call.getString("folder");
        try {
            JSArray names = call.getArray("names");
            JSArray files = new JSArray();
            byte[] buf = new byte[1 << 16];
            for (int i = 0; i < names.length(); i++) {
                JSObject f = new JSObject();
                try (InputStream in = openIn(folder, names.getString(i))) {
                    MessageDigest md = MessageDigest.getInstance("SHA-256");
                    long size = 0;
                    for (int n; (n = in.read(buf)) > 0; size += n) md.update(buf, 0, n);
                    f.put("exists", true);
                    f.put("size", size);
                    f.put("sha256", String.format("%064x", new BigInteger(1, md.digest())));
                } catch (FileNotFoundException e) {
                    f.put("exists", false);
                }
                files.put(f);
            }
            JSObject r = new JSObject();
            r.put("files", files);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    // Appends parts to the file "to"/"name": { data } (base64, small) or { folder, name } (a whole file, copied here).
    // Returns the bytes written for each part.
    @PluginMethod
    public void append(PluginCall call) {
        try (OutputStream out = openOut(call.getString("to"), call.getString("name"), true)) {
            JSArray parts = call.getArray("parts");
            JSArray sizes = new JSArray();
            for (int i = 0; i < parts.length(); i++) {
                JSONObject p = parts.getJSONObject(i);
                if (p.has("data")) {
                    byte[] b = Base64.decode(p.getString("data"), Base64.DEFAULT);
                    out.write(b);
                    sizes.put(b.length);
                } else {
                    try (InputStream in = openIn(p.getString("folder"), p.getString("name"))) {
                        sizes.put(pump(in, out));
                    }
                }
            }
            JSObject r = new JSObject();
            r.put("sizes", sizes);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    private static long pump(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[1 << 16];
        long total = 0;
        for (int n; (n = in.read(buf)) > 0; total += n) out.write(buf, 0, n);
        return total;
    }

    // ---------- a stored document for the phone's own apps ----------

    // A copy of a stored file in the phone's Downloads, named "as" (Android adds " (1)" on a clash). MediaStore needs no
    // permission; the copy stays hidden until it is complete and is removed if copying fails. Returns the name it got.
    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        Uri item = null;
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, call.getString("as"));
            v.put(MediaStore.MediaColumns.MIME_TYPE, call.getString("mime"));
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            item = cr().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (item == null) throw new IOException("Downloads is not available");
            try (InputStream in = openIn(call.getString("folder"), call.getString("name")); OutputStream out = cr().openOutputStream(item)) {
                if (out == null) throw new IOException("Could not write to Downloads");
                pump(in, out);
            }
            v.clear();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr().update(item, v, null, null);
            JSObject r = new JSObject();
            try (Cursor c = cr().query(item, new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null)) {
                r.put("name", c != null && c.moveToFirst() ? c.getString(0) : call.getString("as"));
            }
            call.resolve(r);
        } catch (Exception e) {
            if (item != null) cr().delete(item, null, null);
            call.reject(e.getMessage(), e);
        }
    }

    // The system share sheet. The file goes as a copy named "as" in the app's cache, so the receiving app shows the
    // document's name rather than the stored random one. Each share replaces the previous copy. move: the file is
    // already a copy in the cache (a backup), so it is moved there instead of copied: no second copy of a big file.
    // ponytail: the last shared copy stays in the cache until the next share (or Android clears it).
    @PluginMethod
    public void share(PluginCall call) {
        File dir = new File(getContext().getCacheDir(), "shared");
        try {
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) f.delete();
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not create " + dir.getPath());
            File copy = new File(dir, call.getString("as"));
            boolean moved = call.getBoolean("move", false) && new File(call.getString("folder"), call.getString("name")).renameTo(copy);
            if (!moved) {
                try (InputStream in = openIn(call.getString("folder"), call.getString("name")); OutputStream out = new FileOutputStream(copy)) {
                    pump(in, out);
                }
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", copy);
            Intent send = new Intent(Intent.ACTION_SEND).setType(call.getString("mime")).putExtra(Intent.EXTRA_STREAM, uri);
            send.setClipData(ClipData.newRawUri("", uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(Intent.createChooser(send, null));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }
}
