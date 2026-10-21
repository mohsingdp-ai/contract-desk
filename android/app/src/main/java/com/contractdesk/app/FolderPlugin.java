package com.contractdesk.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.provider.Settings;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
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

    // Replaces "to" with "from". Plain paths: one atomic rename. Picker links can't rename over a file, so the old
    // one is deleted first; a crash in between leaves only the .tmp, which start-up recovers.
    @PluginMethod
    public void rename(PluginCall call) {
        String folder = call.getString("folder");
        String from = call.getString("from");
        String to = call.getString("to");
        try {
            if (isTree(folder)) {
                if (treeExists(folder, to)) DocumentsContract.deleteDocument(cr(), doc(folder, to));
                if (DocumentsContract.renameDocument(cr(), doc(folder, from), to) == null) throw new IOException("Could not rename " + from);
            } else if (!new File(folder, from).renameTo(new File(folder, to))) {
                throw new IOException("Could not rename " + from + " to " + to);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String folder = call.getString("folder");
        String name = call.getString("name");
        try {
            if (isTree(folder)) {
                if (treeExists(folder, name)) DocumentsContract.deleteDocument(cr(), doc(folder, name));
            } else {
                File f = new File(folder, name);
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

    // Copies one file between data folders (moving records to a new folder). Returns the bytes copied.
    @PluginMethod
    public void copy(PluginCall call) {
        String name = call.getString("name");
        try (InputStream in = openIn(call.getString("from"), name); OutputStream out = openOut(call.getString("to"), name, false)) {
            byte[] buf = new byte[1 << 16];
            long total = 0;
            for (int n; (n = in.read(buf)) > 0; total += n) out.write(buf, 0, n);
            JSObject r = new JSObject();
            r.put("bytes", total);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }
}
