package com.banzou.ktv

import android.os.Environment
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** 电脑端建的歌单：songs 是歌的编号 */
data class Playlist(val id: String, val name: String, val songs: List<String>)

/**
 * 一首歌。电视歌单里有电脑上的全部歌（.catalog/catalog.json，带副歌预览）；
 * 整首歌传到电视上以后才有 media（/sdcard/BanzouKTV/<歌名>/）。
 */
data class Song(
    val id: String,
    val title: String,
    val artist: String?,
    /** 拼音首字母 + 英文单词首字母，比如 JMXSCG */
    val initials: String,
    /** 副歌预览（mp4 有画面，m4a 只有声音） */
    val preview: File?,
    /** 整首歌的文件；null 表示还在电脑上 */
    val media: File?,
    val hasVideo: Boolean,
    val hasVocal: Boolean,
    val lyricsInVideo: Boolean,
    val lyricsFile: File?,
    /** 电脑端打的标签：语种（国语/粤语/英文/日语/韩语/其他）和年代（80s…），没有就是空 */
    val lang: String = "",
    val era: String = "",
) {
    val onTv: Boolean get() = media != null
    fun lyrics(): Lyrics = lyricsFile?.takeIf { it.exists() }?.let { Lrc.parse(it.readText()) } ?: Lyrics.EMPTY
}

data class LyricLine(val startMs: Long, val text: String)

class Lyrics(val credits: List<String>, val lines: List<LyricLine>) {
    companion object {
        val EMPTY = Lyrics(emptyList(), emptyList())
    }
}

object Library {
    val root: File get() = File(Environment.getExternalStorageDirectory(), "BanzouKTV")
    private val catalogDir get() = File(root, ".catalog")
    private val requestDir get() = File(root, ".requests")

    /** 和电脑那边（tv.rs 的 song_id）一样：歌名 SHA-256 的前 6 个字节 */
    fun songId(title: String): String =
        MessageDigest.getInstance("SHA-256").digest(title.trim().toByteArray()).take(6).joinToString("") { "%02x".format(it) }

    fun scan(): List<Song> {
        // 已经传到电视上的整首歌
        val local = HashMap<String, Song>()
        root.listFiles { f -> f.isDirectory && !f.name.startsWith(".") && !f.name.endsWith(".part") }?.forEach { dir ->
            try {
                val info = JSONObject(File(dir, "info.json").readText())
                val media = File(dir, info.getString("media"))
                if (!media.exists()) return@forEach
                // info.json：title = 电脑上的文件名键（文件夹名），id = 稳定编号，name = 显示名。
                // 老版本电脑传的没有 id / name，编号按 title 算（和以前一样）
                val key = info.optString("title", dir.name)
                val id = info.optString("id").ifEmpty { songId(key) }
                val title = info.optString("name").ifEmpty { key }
                local[id] = Song(
                    id = id, title = title, artist = null, initials = latinInitials(title), preview = null,
                    media = media,
                    hasVideo = info.optBoolean("video", false),
                    hasVocal = info.optBoolean("vocal", false),
                    lyricsInVideo = info.optBoolean("lyricsInVideo", false),
                    lyricsFile = File(dir, "lyrics.lrc"),
                )
            } catch (_: Exception) {
            }
        }
        // 电脑同步过来的全部歌单
        val out = ArrayList<Song>()
        try {
            val arr = JSONObject(File(catalogDir, "catalog.json").readText()).getJSONArray("songs")
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val id = o.getString("id")
                val preview = File(catalogDir, o.optString("preview")).takeIf { o.has("preview") && it.exists() }
                val base = local.remove(id)
                out += (base ?: Song(id, o.getString("title"), null, "", null, null, false, false, false, null)).copy(
                    // 歌名以电脑同步来的歌单为准（电脑上改了显示名，已经传到电视的歌也跟着变）
                    title = o.optString("title").ifEmpty { base?.title ?: id },
                    artist = o.optString("artist").takeIf { it.isNotEmpty() && it != "null" },
                    initials = o.optString("initials"),
                    preview = preview,
                    lang = o.optString("lang"),
                    era = o.optString("era"),
                )
            }
        } catch (_: Exception) {
        }
        out += local.values // 电视上有、歌单里没有的（还没同步过歌单）
        return out.sortedWith(compareBy({ !it.onTv }, { it.initials }, { it.title }))
    }

    /** 电脑同步过来的歌单（老版本的歌单文件里没有，就是空的） */
    fun playlists(): List<Playlist> = try {
        val arr = JSONObject(File(catalogDir, "catalog.json").readText()).optJSONArray("playlists")
        (0 until (arr?.length() ?: 0)).map { i ->
            val o = arr!!.getJSONObject(i)
            val ids = o.optJSONArray("songs")
            Playlist(o.optString("id"), o.optString("name"), (0 until (ids?.length() ?: 0)).map { ids!!.getString(it) })
        }.filter { it.name.isNotEmpty() }
    } catch (_: Exception) {
        emptyList()
    }

    private val playsFile get() = File(catalogDir, "plays.json")

    /** 每首歌被点过几次（编号 → 次数）。「常点」就是从这里来的，电脑同步时会拉走 */
    fun plays(): Map<String, Int> = try {
        val o = JSONObject(playsFile.readText())
        o.keys().asSequence().associateWith { o.optInt(it) }
    } catch (_: Exception) {
        emptyMap()
    }

    /** 点一次记一次（先写临时文件再改名，不会写坏） */
    @Synchronized
    fun countPlay(song: Song) {
        try {
            catalogDir.mkdirs()
            val o = JSONObject()
            val cur = plays().toMutableMap()
            cur[song.id] = (cur[song.id] ?: 0) + 1
            cur.forEach { (k, v) -> o.put(k, v) }
            val tmp = File(catalogDir, "plays.json.tmp")
            tmp.writeText(o.toString())
            tmp.renameTo(playsFile)
        } catch (e: Exception) {
            android.util.Log.w("BanzouKTV", "countPlay failed", e)
        }
    }

    /** 常点：点过 3 次以上，按次数从多到少，最多 30 首 */
    fun frequent(songs: List<Song>): List<Song> {
        val p = plays()
        return songs.filter { (p[it.id] ?: 0) >= 3 }.sortedByDescending { p[it.id] ?: 0 }.take(30)
    }

    /** 让电脑把这首整首传过来（电脑上的波点开着时，几秒内会看到） */
    fun request(song: Song) {
        requestDir.mkdirs()
        File(requestDir, "${song.id}.fail").delete()
        File(requestDir, "${song.id}.req").writeText(song.title)
    }

    fun isRequested(song: Song) = File(requestDir, "${song.id}.req").exists()

    /** 电脑传不了的歌：编号 → 原因（读一次就删掉） */
    fun takeFailures(): Map<String, String> {
        val files = requestDir.listFiles { f -> f.name.endsWith(".fail") } ?: return emptyMap()
        return files.associate { f -> f.name.removeSuffix(".fail") to f.readText().trim().also { f.delete() } }
    }

    /** 搜索：首字母（JMXS）或歌名里的字（英文不分大小写） */
    fun search(songs: List<Song>, query: String): List<Song> {
        val q = query.trim().uppercase()
        if (q.isEmpty()) return songs
        val hits = songs.filter { it.initials.contains(q) || it.title.uppercase().contains(q) || (it.artist?.uppercase()?.contains(q) ?: false) }
        return hits.sortedBy { if (it.initials.startsWith(q)) 0 else 1 }
    }

    private fun latinInitials(t: String) = t.split(' ').mapNotNull { w -> w.firstOrNull()?.takeIf { it.isLetterOrDigit() && it.code < 128 }?.uppercaseChar() }.joinToString("")
}

object Lrc {
    private val TAG = Regex("""\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?]""")
    private val CREDIT = Regex("""^(词|曲|作词|作曲|编曲|制作人?|监制|演唱|原唱|和声|混音|录音|Lyrics?|Composer|Producer)\s*[:：]""", RegexOption.IGNORE_CASE)

    fun parse(text: String): Lyrics {
        val all = mutableListOf<LyricLine>()
        for (raw in text.lines()) {
            val tags = TAG.findAll(raw).toList()
            if (tags.isEmpty()) continue
            val body = raw.substring(tags.last().range.last + 1).trim()
            for (m in tags) {
                val (mm, ss, frac) = m.destructured
                val ms = when (frac.length) { 0 -> 0L; 1 -> frac.toLong() * 100; 2 -> frac.toLong() * 10; else -> frac.toLong() }
                all += LyricLine(mm.toLong() * 60_000 + ss.toLong() * 1000 + ms, body)
            }
        }
        all.sortBy { it.startMs }
        val credits = mutableListOf<String>()
        val lines = mutableListOf<LyricLine>()
        for (l in all) {
            if (l.text.isEmpty()) continue
            // 开头的「歌名 - 歌手」「词：」「曲：」当片头字幕，不算要唱的句子
            val isCredit = CREDIT.containsMatchIn(l.text) || (lines.isEmpty() && l.startMs < 8000 && l.text.contains(" - "))
            if (isCredit && lines.isEmpty()) credits += l.text else lines += l
        }
        return Lyrics(credits, lines)
    }
}
