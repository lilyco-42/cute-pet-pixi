package rust.cute_pet;

import android.content.Context;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.GZIPInputStream;

/**
 * 素材按需拉取（Android 侧）—— 与 Electron 侧 electron/packs.js 同一套约定：
 *   索引 assets/packs-index.json -> 下载 <prefix>-<slug>-<ver>.tar.gz -> 校验 bytes/sha256 -> 解压
 *   落到 getExternalFilesDir()/assets/packs/<id>/
 *
 * 为什么不用 APK 内 assets 装第三方素材：版权素材不该随安装包分发（合规），
 * 而且 asset 是只读的，放不下运行时下载的东西。
 */
public final class PackFetcher {
    private static final String TAG = "cute-pet";
    public static final String BASE = "assets/packs";

    /** 同步完成后的回调：允许调用方在素材拉完后刷新正在运行的桌宠。 */
    public interface Done { void run(String result); }
    public interface Log { void log(String s); }

    /** 同时写 logcat —— MainActivity 那条路径没有别的出口，不写这里排查时两眼一抹黑 */
    private static void say(Log log, String s) {
        // 注意用全限定名：本类里的接口也叫 Log，会把 android.util.Log 遮住
        android.util.Log.i(TAG, "[packs] " + s);
        if (log != null) log.log(s);
    }

    public static File packRoot(Context ctx) {
        return new File(ctx.getExternalFilesDir(null), BASE);
    }

    /** 选一个已安装的素材包：按名字排序取第一个（arknights- < chibi < nctype-），
     *  所以只要装了角色包就用角色包，没装才回落内置 chibi。 */
    public static String pickPack(Context ctx) {
        File root = packRoot(ctx);
        if (!root.isDirectory()) return null;
        File[] kids = root.listFiles();
        if (kids == null) return null;
        String best = null;
        for (File d : kids) {
            if (!d.isDirectory()) continue;
            if (!new File(d, "pack.json").isFile()) continue;
            String n = d.getName();
            if (best == null || n.compareTo(best) < 0) best = n;
        }
        return best;
    }

    public static void sync(Context ctx, Log log, Done done) {
        final Done d = done;
        new Thread(new Runnable() {
            @Override public void run() {
                String r = syncBlocking(ctx, log);
                if (d != null) d.run(r);
            }
        }, "pack-fetch").start();
    }

    /** 同步版：阻塞到下载/解压完成，返回结果消息。 */
    public static String syncBlocking(Context ctx, Log log) {
        int installed = 0, skipped = 0, failed = 0;
        try {
            String index = readIndex(ctx);
            List<String> objs = splitObjects(index);
            say(log, "索引里 " + objs.size() + " 个素材包");
            for (String o : objs) {
                String id = str(o, "id");
                String url = str(o, "url");
                long bytes = num(o, "bytes");
                String sha = str(o, "sha256");
                if (id == null || url == null || id.isEmpty()) continue;
                File dest = new File(packRoot(ctx), id);
                if (new File(dest, "pack.json").exists()) { skipped++; continue; }
                try {
                    say(log, "拉取 " + id + "  (" + (bytes / 1048576) + " MB) " + url.substring(0, Math.min(60, url.length())));
                    File tmp = File.createTempFile("pack", ".tar.gz", ctx.getCacheDir());
                    download(url, tmp);
                    if (bytes > 0 && tmp.length() != bytes) throw new IOException("大小不符 " + tmp.length() + " != " + bytes);
                    if (sha != null && !sha.isEmpty()) {
                        String h = sha256(tmp);
                        if (!h.equalsIgnoreCase(sha)) throw new IOException("sha256 不符");
                    }
                    deleteRec(dest);
                    untarGz(tmp, dest);
                    tmp.delete();
                    if (!new File(dest, "pack.json").exists()) throw new IOException("解压后没有 pack.json");
                    installed++;
                    say(log, "已安装 " + id);
                } catch (Exception e) {
                    deleteRec(dest);
                    failed++;
                    say(log, "失败 " + id + ": " + e.getClass().getSimpleName() + " " + e.getMessage());
                }
            }
        } catch (Exception e) {
            say(log, "素材同步异常: " + e);
            return "error";
        }
        String r = "素材同步: 新增 " + installed + " / 跳过 " + skipped + " / 失败 " + failed;
        say(log, r);
        return r;
    }

    private static String readIndex(Context ctx) throws IOException {
        File cached = new File(packRoot(ctx), "packs-index.json");
        if (cached.isFile()) return readAll(new FileInputStream(cached));
        return readAll(ctx.getAssets().open("web/assets/packs-index.json"));
    }

    private static void download(String url, File dest) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.connect();
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) throw new IOException("HTTP " + code);
        try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally { c.disconnect(); }
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /** 极简 ustar 解压。tar 是外部输入，必须挡住路径穿越。 */
    private static int untarGz(File gz, File destDir) throws IOException {
        String destCanon = destDir.getCanonicalPath();
        int count = 0;
        try (GZIPInputStream in = new GZIPInputStream(new FileInputStream(gz))) {
            byte[] header = new byte[512];
            while (readFully(in, header)) {
                boolean allZero = true;
                for (byte b : header) if (b != 0) { allZero = false; break; }
                if (allZero) break;
                String name = cstr(header, 0, 100);
                String prefix = cstr(header, 345, 155);
                if (!prefix.isEmpty()) name = prefix + "/" + name;
                long size = octal(header, 124, 12);
                char type = (char) (header[156] & 0xff);
                if (type == '0' || type == 0) {
                    File out = new File(destDir, name);
                    String outCanon = out.getCanonicalPath();
                    if (!outCanon.equals(destCanon) && !outCanon.startsWith(destCanon + File.separator))
                        throw new IOException("tar 路径越界: " + name);
                    File parent = out.getParentFile();
                    if (parent != null) parent.mkdirs();
                    try (FileOutputStream fo = new FileOutputStream(out)) {
                        long left = size;
                        byte[] buf = new byte[65536];
                        while (left > 0) {
                            int want = (int) Math.min(buf.length, left);
                            int n = in.read(buf, 0, want);
                            if (n < 0) throw new IOException("tar 数据截断");
                            fo.write(buf, 0, n);
                            left -= n;
                        }
                    }
                    count++;
                } else {
                    // 跳过非普通文件的数据块
                    long left = size;
                    byte[] buf = new byte[65536];
                    while (left > 0) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                        if (n < 0) break;
                        left -= n;
                    }
                }
                long pad = (512 - (size % 512)) % 512;
                byte[] skip = new byte[(int) pad];
                readFully(in, skip);
            }
        }
        return count;
    }

    private static boolean readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) return false;
            off += n;
        }
        return true;
    }

    private static String cstr(byte[] b, int off, int len) {
        int end = off;
        while (end < off + len && b[end] != 0) end++;
        return new String(b, off, end - off);
    }

    private static long octal(byte[] b, int off, int len) {
        String s = cstr(b, off, len).trim();
        if (s.isEmpty()) return 0;
        try { return Long.parseLong(s, 8); } catch (Exception e) { return 0; }
    }

    private static void deleteRec(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) { File[] kids = f.listFiles(); if (kids != null) for (File k : kids) deleteRec(k); }
        f.delete();
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream i = in) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = i.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), "UTF-8");
        }
    }

    // ---- 极简 JSON：只取 packs 数组里的平坦对象（本项目的索引格式固定） ----
    public static List<String> splitObjects(String json) {
        List<String> out = new ArrayList<>();
        int i = json.indexOf("\"packs\"");
        if (i < 0) return out;
        i = json.indexOf('[', i);
        if (i < 0) return out;
        int depth = 0, start = -1;
        boolean inStr = false;
        for (int p = i + 1; p < json.length(); p++) {
            char c = json.charAt(p);
            if (inStr) {
                if (c == '\\') p++;
                else if (c == '"') inStr = false;
                continue;
            }
            if (c == '"') { inStr = true; continue; }
            if (c == '{') { if (depth == 0) start = p; depth++; }
            else if (c == '}') { depth--; if (depth == 0 && start >= 0) { out.add(json.substring(start, p + 1)); start = -1; } }
            else if (c == ']' && depth == 0) break;
        }
        return out;
    }

    public static String str(String obj, String key) {
        String k = "\"" + key + "\"";
        int i = obj.indexOf(k);
        if (i < 0) return null;
        i = obj.indexOf(':', i + k.length());
        if (i < 0) return null;
        i++;
        while (i < obj.length() && Character.isWhitespace(obj.charAt(i))) i++;
        if (i >= obj.length() || obj.charAt(i) != '"') return null;
        StringBuilder sb = new StringBuilder();
        for (int p = i + 1; p < obj.length(); p++) {
            char c = obj.charAt(p);
            if (c == '\\') { p++; if (p < obj.length()) sb.append(obj.charAt(p)); continue; }
            if (c == '"') break;
            sb.append(c);
        }
        return sb.toString();
    }

    public static long num(String obj, String key) {
        String k = "\"" + key + "\"";
        int i = obj.indexOf(k);
        if (i < 0) return 0;
        i = obj.indexOf(':', i + k.length());
        if (i < 0) return 0;
        i++;
        while (i < obj.length() && Character.isWhitespace(obj.charAt(i))) i++;
        int j = i;
        while (j < obj.length() && "0123456789".indexOf(obj.charAt(j)) >= 0) j++;
        try { return j > i ? Long.parseLong(obj.substring(i, j)) : 0; } catch (Exception e) { return 0; }
    }
}
