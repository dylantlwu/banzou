package com.banzou.ktv

import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.AbsListView
import android.widget.AdapterView
import android.widget.BaseAdapter
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max

class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())

    private lateinit var player: ExoPlayer
    private val mixer = VocalMixer()
    /** 点歌页右上角放副歌预览（只在没在唱的时候放，老电视同时解两路视频吃不消） */
    private var preview: ExoPlayer? = null

    private lateinit var root: FrameLayout
    private lateinit var surface: SurfaceView
    private lateinit var lyricsView: LyricsView
    private lateinit var noMv: NoMvView
    private lateinit var pauseCard: PauseCard
    private lateinit var toast: ToastView
    private lateinit var langCard: LangCard
    private lateinit var panel: FrameLayout
    private lateinit var content: FrameLayout
    private lateinit var emptyView: EmptyView
    private lateinit var lockup: LockupView
    private lateinit var headerDivider: View
    private lateinit var status: TextView
    private lateinit var phoneHint: TextView
    private lateinit var langChip: TextView
    private lateinit var phoneChip: TextView
    private lateinit var qrCard: QrCard
    /** 从哪一栏按「上」到顶栏的牌子；按「下」回去 */
    private var chipReturn: View? = null
    private lateinit var queryView: TextView
    private lateinit var keypad: KeypadView
    private lateinit var listHead: TextView
    private lateinit var libList: ListView
    private lateinit var queueHead: TextView
    private lateinit var queueList: ListView
    private lateinit var previewSurface: SurfaceView
    private lateinit var previewLabel: TextView
    private lateinit var previewCap: TextView
    private lateinit var previewTitle: TextView
    private lateinit var hints: HintsView
    private var intro: IntroView? = null

    // v9：筛选排、年代 / 歌手卡片、我的歌单
    private lateinit var strip: FilterStrip
    private lateinit var stripRule: View
    private lateinit var plChip: TextView
    private val plIcon = ListIcon()
    private lateinit var gridCard: GridCard
    private lateinit var plHead: TextView
    private lateinit var plList: ListView
    private lateinit var plEmpty: TextView
    private lateinit var midEmpty: ListEmptyView
    private lateinit var previewTags: TagLine
    /** 现在的筛选（一次一个，见 [Filters]）；只管点歌页，手机点歌不受影响 */
    private var filter = Filters.ALL
    private var chips: List<Filters.Chip> = listOf(Filters.Chip(Filters.ALL, false))
    /** 常点的歌：编号 → 名次（0 最常点） */
    private var favRank: Map<String, Int> = emptyMap()
    /** 从哪一栏（字母键 / 歌单）上到筛选排；按「下」回去 */
    private var stripReturn: View? = null
    /** 现在是不是「我的歌单」页 */
    private var listsMode = false
    private var playlists: List<Playlist> = emptyList()
    /** 歌单页正在看的那张（记编号，同步以后还能对回去） */
    private var plId: String? = null

    private var songs: List<Song> = emptyList()
    private var shown: List<Song> = emptyList()
    private var query = ""
    /** 已点：存歌的编号，播放时再按编号找最新的（整首可能刚从电脑传过来） */
    private val queue = mutableListOf<String>()
    private var current: Song? = null
    private var vocalOn = false
    /** 原唱打开时人声的音量（手机上可以调小当导唱） */
    private var vocalVol = 1f
    private var musicVol = 1f
    private var lyricsOn = true
    /** 歌词延后多少毫秒（接蓝牙音箱时声音会晚） */
    private var offsetMs = 0L
    private lateinit var remote: RemoteServer
    /** 现在是不是「还没有歌」那一页 */
    private var emptyShown = false
    /** 打开语言卡片之前焦点在哪，关掉以后还回去 */
    private var langReturn: View? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        Art.init(this)
        L.load(this)
        offsetMs = getPreferences(MODE_PRIVATE).getLong("offsetMs", 0L)
        buildUi()
        buildPlayer()
        showPanel()
        remote = RemoteServer({
            // 有手机打开了遥控网页（多半是刚扫了码）：二维码卡片开着就收起来
            main.post { if (qrCard.visibility == View.VISIBLE) { closeQr(); flash(L.t("tPhoneJoined")) } }
            assets.open("remote.html").use { it.readBytes() }
        }, ::onRemote)
        remote.start()
        intro = IntroView(this) { endIntro() }.also { root.addView(it, FrameLayout.LayoutParams(-1, -1)) }
        main.postDelayed(poll, 4000)
    }

    private fun endIntro() {
        val v = intro ?: return
        intro = null
        root.removeView(v)
        focusPanel()
        schedulePreview()
    }

    override fun onResume() {
        super.onResume()
        refreshLibrary()
    }

    override fun onPause() {
        super.onPause()
        stopPreview()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        remote.stop()
        preview?.release()
        player.release()
        super.onDestroy()
    }

    // ---------- 播放 ----------

    private fun buildPlayer() {
        // 声音优先用安卓自带的软件解码器：电视的硬件解码器可能把 4 声道混成 2 声道，原唱/伴唱就分不开了
        val selector = MediaCodecSelector { mime, secure, tunneling ->
            val all = MediaCodecUtil.getDecoderInfos(mime, secure, tunneling)
            if (mime.startsWith("audio/")) all.sortedBy { if (it.name.startsWith("OMX.google.") || it.name.startsWith("c2.android.")) 0 else 1 } else all
        }
        val renderers = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
                DefaultAudioSink.Builder(context).setAudioProcessors(arrayOf(mixer)).build()
        }.setMediaCodecSelector(selector)
        player = ExoPlayer.Builder(this, renderers).build()
        player.setVideoSurfaceView(surface)
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) playNext()
                updatePause()
            }
            override fun onPlayerError(error: PlaybackException) {
                Log.e(TAG, "play error", error)
                flash(L.t("cantPlay", "t" to (current?.title ?: L.t("thisSong"))), L.t("skipping"), err = true)
                main.postDelayed({ playNext() }, 1500)
            }
            override fun onVideoSizeChanged(size: VideoSize) = fitVideo(size)
            override fun onIsPlayingChanged(isPlaying: Boolean) = updatePause()
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = updatePause()
        })
        lyricsView.clock = LyricsView.Clock { if (current != null) player.currentPosition - offsetMs else LyricsView.NOT_PLAYING }
    }

    private fun play(song: Song) {
        val media = song.media ?: return
        stopPreview()
        current = song
        lyricsOn = !song.lyricsInVideo
        val lyrics = song.lyrics()
        lyricsView.title = song.title
        lyricsView.artist = song.artist ?: ""
        lyricsView.lyrics = lyrics
        applyVolumes()
        surface.visibility = if (song.hasVideo) View.VISIBLE else View.GONE
        noMv.title = song.title
        noMv.artist = song.artist ?: ""
        noMv.visibility = if (song.hasVideo) View.GONE else View.VISIBLE
        player.setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(media)))
        prepareAndPlay()
        // 开头有歌名卡片的时候，消息条里就不再写歌名
        val first = lyrics.lines.firstOrNull()?.startMs
        val cardShown = lyricsOn && first != null && first > 4000
        val mode = L.t(if (vocalOn) "vocalOn" else "vocalOff")
        val next = queue.firstOrNull()?.let { id -> byId(id)?.title }?.let { L.t("nextT", "t" to it) }
        flash(if (cardShown) mode else "${song.title}　$mode", next, ms = 5000)
        refreshLists()
        updateLyricsVisibility()
    }

    private fun prepareAndPlay() {
        player.prepare()
        player.play()
    }

    /** 放已点里第一首已经在电视上的；都还在传就等着 */
    private fun playNext() {
        val idx = queue.indexOfFirst { byId(it)?.onTv == true }
        if (idx >= 0) {
            play(byId(queue.removeAt(idx))!!)
            return
        }
        current = null
        player.stop()
        surface.visibility = View.GONE
        noMv.visibility = View.GONE
        showPanel()
    }

    private fun fitVideo(size: VideoSize) {
        if (size.width == 0 || size.height == 0) return
        val ratio = size.width * size.pixelWidthHeightRatio / size.height
        val rw = root.width.toFloat(); val rh = root.height.toFloat()
        val lp = surface.layoutParams as FrameLayout.LayoutParams
        if (rw / rh > ratio) { lp.height = rh.toInt(); lp.width = (rh * ratio).toInt() } else { lp.width = rw.toInt(); lp.height = (rw / ratio).toInt() }
        lp.gravity = Gravity.CENTER
        surface.layoutParams = lp
    }

    private fun byId(id: String) = songs.firstOrNull { it.id == id }

    private val panelVisible get() = panel.visibility == View.VISIBLE

    /** 歌词只在唱歌画面上画；点歌页盖着的时候不用每帧重画 */
    private fun updateLyricsVisibility() {
        lyricsView.visibility = if (lyricsOn && current != null && !panelVisible) View.VISIBLE else View.GONE
    }

    /** 暂停卡片：正在唱、点歌页没开、是用户按的暂停 */
    private fun updatePause() {
        val paused = current != null && !panelVisible && player.playbackState == Player.STATE_READY && !player.playWhenReady
        pauseCard.visibility = if (paused) View.VISIBLE else View.GONE
        lyricsView.hideCard = paused
        lyricsView.invalidate()
    }

    // ---------- 副歌预览 ----------

    private val startPreview = Runnable {
        val song = selectedSong()
        if (song == null || !panelVisible || intro != null || emptyShown) {
            // 没有歌（空歌单、没找到）：试听是空图版（灰底 + 徽记）
            if (song == null) { stopPreview(); previewNote("", emblem = true); previewTitle.text = "" }
            return@Runnable
        }
        previewTitle.text = song.title
        if (current != null) {
            stopPreview(); previewNote(L.t("noPreviewSinging")); return@Runnable
        }
        val file = song.preview
        if (file == null) {
            stopPreview(); previewNote(L.t("noPreview1") + "\n" + L.t("noPreview2")); return@Runnable
        }
        val p = preview ?: ExoPlayer.Builder(this).build().also {
            it.setVideoSurfaceView(previewSurface)
            it.repeatMode = Player.REPEAT_MODE_OFF   // 副歌只放一次，放完停在最后一帧
            preview = it
        }
        val video = file.name.endsWith(".mp4")
        previewSurface.visibility = if (video) View.VISIBLE else View.INVISIBLE
        previewLabel.setCompoundDrawables(null, null, null, null)
        previewLabel.text = "♪"
        previewLabel.visibility = if (video) View.GONE else View.VISIBLE
        previewCap.visibility = View.VISIBLE
        p.setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(file)))
        p.prepare()
        p.play()
    }

    /** 试听框里不放画面，只写一句话 */
    private fun previewNote(text: String, emblem: Boolean = false) {
        previewLabel.setCompoundDrawables(null, if (emblem) previewEmblem else null, null, null)
        previewLabel.text = text
        previewLabel.visibility = View.VISIBLE
        previewCap.visibility = View.INVISIBLE
    }

    private val previewEmblem by lazy { EmblemDrawable(64f).apply { setBounds(0, 0, intrinsicWidth, intrinsicHeight) } }

    /** 歌单那一栏里焦点所在（没有焦点时是选中）的那首 */
    private fun selectedSong(): Song? = if (shown.isEmpty()) null else shown.getOrNull(libList.selectedItemPosition.coerceAtLeast(0))

    /** 试听下面右头的「国语 · 00s」：只给焦点那首歌看，没有标签就空着 */
    private fun updateTags() {
        val s = selectedSong()
        val lang = s?.let { Filters.langGroup(it.lang) }?.let { L.t(Filters.LANG_KEY[it] ?: "fOther") } ?: ""
        val era = s?.era?.trim()?.takeIf { it.isNotEmpty() }?.let { V9.eraLabel(it) } ?: ""
        previewTags.set(lang, era)
    }

    private fun schedulePreview() {
        main.removeCallbacks(startPreview)
        main.postDelayed(startPreview, 700)
    }

    private fun stopPreview() {
        main.removeCallbacks(startPreview)
        preview?.stop()
        if (::previewSurface.isInitialized) previewSurface.visibility = View.INVISIBLE
    }

    // ---------- 遥控器 ----------

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (intro != null) {
            if (event.action == KeyEvent.ACTION_DOWN) intro?.skip()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            if (langCard.visibility == View.VISIBLE || qrCard.visibility == View.VISIBLE || gridCard.visibility == View.VISIBLE) return true
            when {
                !panelVisible -> showPanel()
                queueList.hasFocus() -> removeFromQueue()
                // 菜单键：从歌单、字母键的任何一行直接到筛选排（歌单页里没有筛选）
                !listsMode && !emptyShown && (libList.hasFocus() || keypad.hasFocus()) -> toStrip(currentFocus)
            }
            return true
        }
        if (panelVisible || current == null) return super.onKeyDown(keyCode, event)
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ->
                if (player.isPlaying) player.pause() else player.play()
            KeyEvent.KEYCODE_DPAD_UP -> toggleVocal()
            KeyEvent.KEYCODE_DPAD_DOWN -> toggleLyrics()
            KeyEvent.KEYCODE_DPAD_RIGHT -> { flash(L.t("skip")); playNext() }
            KeyEvent.KEYCODE_DPAD_LEFT -> restart()
            else -> return super.onKeyDown(keyCode, event)
        }
        return true
    }

    @Deprecated("TV remote back key")
    override fun onBackPressed() {
        if (langCard.visibility == View.VISIBLE) { closeLang(); return }
        if (qrCard.visibility == View.VISIBLE) { closeQr(); return }
        if (gridCard.visibility == View.VISIBLE) { closeGrid(); return }
        // 歌单页：在哪按返回都回点歌页，焦点落在顶栏的「我的歌单」上
        if (panelVisible && listsMode) { setListsMode(false); plChip.requestFocus(); return }
        if (panelVisible && query.isNotEmpty() && keypad.hasFocus()) { setQuery(query.dropLast(1)); return }
        // 有筛选时：在筛选排按返回 = 清掉，焦点到「全部」；在歌单按返回 = 清掉，回到第一首
        if (panelVisible && filter != Filters.ALL && strip.hasFocus()) { setFilter(Filters.ALL); strip.focusIdx = 0; strip.invalidate(); return }
        if (panelVisible && filter != Filters.ALL && libList.hasFocus()) { setFilter(Filters.ALL); return }
        if (panelVisible && current != null) hidePanel()
        else if (!panelVisible) showPanel()
        else super.onBackPressed()
    }

    private fun toggleVocal() {
        val song = current ?: return
        if (!song.hasVocal) { flash(L.t("tNoVocal")); return }
        vocalOn = !vocalOn
        if (vocalOn && vocalVol <= 0f) vocalVol = 1f
        applyVolumes()
        toast.seg(L.t("vocalOn"), L.t("vocalOff"), secondOn = !vocalOn)
        showToast(2000)
    }

    private fun applyVolumes() {
        mixer.targetMusic = musicVol
        mixer.targetGain = if (vocalOn) vocalVol else 0f
    }

    private fun toggleLyrics() {
        lyricsOn = !lyricsOn
        updateLyricsVisibility()
        flash(L.t(if (lyricsOn) "lyricsOn" else "lyricsOff"))
    }

    private fun restart() { player.seekTo(0); player.play(); flash(L.t("restart")) }

    // ---------- 点歌 ----------

    /** 点一首：在电视上的直接唱或排队；还在电脑上的让电脑传过来，先排进已点 */
    private fun pick(song: Song) {
        if (queue.contains(song.id)) { flash(L.t("tAlready", "t" to song.title)); return }
        Library.countPlay(song)
        refreshFavs()
        if (!song.onTv) {
            try { Library.request(song) } catch (e: Exception) {
                android.util.Log.w("BanzouKTV", "request failed", e)
                flash(L.t("tReqFail", "t" to song.title), L.t("tReqFailSub"), err = true); return
            }
            queue += song.id
            flash(L.t("tPicked", "t" to song.title), L.t("tSendingSub"), ms = 5000)
            refreshLists()
            return
        }
        if (current == null && queue.isEmpty()) {
            hidePanel()   // 先收起点歌页，开唱的消息条才会出在唱歌画面该在的位置
            play(song)
            return
        }
        queue += song.id
        flash(L.t("tPicked", "t" to song.title))
        refreshLists()
    }

    /** 每隔几秒看看：电脑传好了没有、有没有传不了的 */
    private val poll: Runnable = object : Runnable {
        override fun run() {
            val waiting = queue.any { byId(it)?.onTv != true }
            if (waiting || (panelVisible && current == null)) {
                val failures = try { Library.takeFailures() } catch (_: Exception) { emptyMap() }
                for ((id, msg) in failures) {
                    // 原因是电脑那边写的，原样显示
                    if (queue.remove(id)) flash(L.t("tFail", "t" to (byId(id)?.title ?: L.t("thisSong"))), msg, err = true, ms = 6000)
                }
                val before = songs.count { it.onTv }
                refreshLibrary()
                if (songs.count { it.onTv } > before) flash(L.t("tArrived"))
                // 电脑传好了、现在没在唱：收起点歌页（卡片开着就先关），直接进 MV
                if (current == null && queue.any { byId(it)?.onTv == true }) {
                    if (langCard.visibility == View.VISIBLE) closeLang()
                    if (qrCard.visibility == View.VISIBLE) closeQr()
                    hidePanel()
                    playNext()
                }
            }
            main.postDelayed(this, 4000)
        }
    }

    private fun bumpToTop(pos: Int) {
        if (pos <= 0 || pos >= queue.size) return
        queue.add(0, queue.removeAt(pos))
        refreshLists()
        queueList.setSelection(0)
        flash(L.t("tTopped"))
    }

    private fun removeFromQueue() {
        if (!queueList.hasFocus()) return
        val pos = queueList.selectedItemPosition
        if (pos !in queue.indices) return
        flash(L.t("tRemoved", "t" to (byId(queue.removeAt(pos))?.title ?: "")))
        refreshLists()
        if (queue.isEmpty()) focusMiddleOrLeft()
    }

    private fun setQuery(q: String) {
        query = q
        showQuery()
        refreshLists()
        libList.setSelection(0)
        schedulePreview()
    }

    /** 搜索框：没输入时是一句提示，输入了就是大一点、拉开字距的字母 */
    private fun showQuery() {
        val empty = query.isEmpty()
        queryView.text = if (empty) L.t("searchHint") else query
        queryView.setTextColor(if (empty) Art.GREY else Art.INK)
        queryView.setTextSize(TypedValue.COMPLEX_UNIT_PX, (if (empty) 27f else 46f) * Art.s)
        queryView.letterSpacing = if (empty) 0.06f else 0.22f
    }

    // ---------- 手机 / iPad 遥控 ----------

    /** 遥控网页发来的命令（在网络线程里调用，转到主线程执行），返回最新状态 */
    private fun onRemote(cmd: String?, p: Map<String, String>): String {
        val latch = java.util.concurrent.CountDownLatch(1)
        var out = "{}"
        main.post {
            try {
                if (cmd != null) runRemote(cmd, p)
                out = stateJson()
            } finally { latch.countDown() }
        }
        latch.await(3, java.util.concurrent.TimeUnit.SECONDS)
        return out
    }

    private fun runRemote(cmd: String, p: Map<String, String>) {
        val i = p["i"]?.toIntOrNull() ?: -1
        val v = p["v"]?.toFloatOrNull()
        when (cmd) {
            "pick" -> (p["id"]?.let { byId(it) } ?: songs.getOrNull(i))?.let { pick(it) }
            "top" -> bumpToTop(i)
            "remove" -> if (i in queue.indices) { flash(L.t("tRemoved", "t" to (byId(queue.removeAt(i))?.title ?: ""))); refreshLists() }
            "pause" -> if (current != null) { if (player.isPlaying) player.pause() else player.play() }
            "next" -> if (current != null) { flash(L.t("skip")); playNext() }
            "restart" -> if (current != null) restart()
            "vocalToggle" -> toggleVocal()
            "lyrics" -> toggleLyrics()
            "panel" -> showPanel()
            "music" -> if (v != null) {
                musicVol = v.coerceIn(0f, 1f); applyVolumes()
                showVolume(L.t("music"), musicVol)
            }
            "vocal" -> if (v != null) {
                vocalVol = v.coerceIn(0f, 1f); vocalOn = vocalVol > 0f; applyVolumes()
                showVolume(L.t("vocal"), vocalVol)
            }
            "offset" -> if (v != null) {
                offsetMs = v.toLong().coerceIn(-2000L, 2000L)
                getPreferences(MODE_PRIVATE).edit().putLong("offsetMs", offsetMs).apply()
                flash(when {
                    offsetMs == 0L -> L.t("offOnTime")
                    offsetMs > 0 -> L.t("offLate", "n" to offsetMs)
                    else -> L.t("offEarly", "n" to -offsetMs)
                })
            }
        }
    }

    /** 手机上拖音量时，唱歌画面上出一条音量提示（点歌页开着就不出） */
    private fun showVolume(label: String, v: Float) {
        if (current == null || panelVisible) return
        toast.volume(label, v)
        showToast(1500)
    }

    private fun stateJson(): String {
        val o = JSONObject()
        o.put("songs", JSONArray(songs.map {
            JSONObject().put("id", it.id).put("title", it.title).put("initials", it.initials)
                .put("artist", it.artist ?: "")
                .put("onTv", it.onTv).put("queued", it.id in queue || it.id == current?.id)
        }))
        // queue 是歌名；sending 里同一位置为 true 表示这首还在从电脑传（文字由手机按它自己的语言写）
        o.put("queue", JSONArray(queue.map { id -> byId(id)?.title ?: "" }))
        o.put("sending", JSONArray(queue.map { id -> byId(id)?.onTv != true }))
        o.put("current", current?.title ?: JSONObject.NULL)
        o.put("currentId", current?.id ?: JSONObject.NULL)
        o.put("artist", current?.artist ?: "")
        o.put("playing", player.isPlaying)
        o.put("position", player.currentPosition)
        o.put("duration", if (player.duration > 0) player.duration else 0)
        o.put("music", musicVol.toDouble())
        o.put("vocal", if (vocalOn) vocalVol.toDouble() else 0.0)
        o.put("hasVocal", current?.hasVocal ?: false)
        o.put("lyrics", lyricsOn)
        o.put("offset", offsetMs)
        return o.toString()
    }

    // ---------- 点歌面板 ----------

    private fun refreshLibrary() {
        val old = selectedSong()
        val sel = old?.id
        songs = Library.scan()
        playlists = Library.playlists()
        current = current?.let { c -> byId(c.id) ?: c }
        refreshFavs()
        // 同步以后选着的歌手 / 年代没了：回到「全部」
        if (!Filters.isValid(songs, filter, favRank.isNotEmpty())) filter = Filters.ALL
        refreshLists()
        if (sel != null) shown.indexOfFirst { it.id == sel }.takeIf { it >= 0 }?.let { libList.setSelection(it) }
        if (listsMode) plList.setSelection(plIndex())
        // 电脑刚同步完歌单：选中的这首有了试听（或换了），马上放
        val now = selectedSong()
        if (panelVisible && (now?.id != old?.id || now?.preview != old?.preview)) schedulePreview()
    }

    /** 常点（点过 3 次以上，按次数排）；点歌以后、同步以后重算 */
    private fun refreshFavs() {
        favRank = Library.frequent(songs).withIndex().associate { it.value.id to it.index }
    }

    /** 歌单页正在看的那张在第几个 */
    private fun plIndex() = playlists.indexOfFirst { it.id == plId }.coerceAtLeast(0)

    /** 一张歌单里的歌（曲库里已经没有的跳过） */
    private fun plSongs(): List<Song> {
        val p = playlists.getOrNull(plIndex()) ?: return emptyList()
        val byIdMap = songs.associateBy { it.id }
        return p.songs.mapNotNull { byIdMap[it] }
    }

    private fun refreshLists() {
        chips = Filters.chips(songs, favRank.isNotEmpty())
        shown = if (listsMode) plSongs() else Filters.apply(Library.search(songs, query), filter, favRank)
        (libList.adapter as BaseAdapter).notifyDataSetChanged()
        (queueList.adapter as BaseAdapter).notifyDataSetChanged()
        (plList.adapter as BaseAdapter).notifyDataSetChanged()
        if (queue.isNotEmpty() && queueList.selectedItemPosition >= queue.size) queueList.setSelection(queue.size - 1)

        strip.update(chips, filter, shown.size)
        setLabel(queueHead, L.t("queue"), if (queue.isEmpty()) null else queue.size.toString())
        if (listsMode) {
            setLabel(plHead, L.t("myLists"), if (playlists.isEmpty()) null else playlists.size.toString())
            // 中标题：歌单的名字（label 样式，但不转大写）+ 靛蓝小数字
            val p = playlists.getOrNull(plIndex())
            if (p == null) listHead.text = "" else {
                listHead.setTextSize(TypedValue.COMPLEX_UNIT_PX, (if (L.isEnglish) 21f else 24f) * Art.s)
                listHead.letterSpacing = if (L.isEnglish) 0.26f else 0.2f
                val n = "　" + shown.size
                val name = V9.fit(p.name, listHead.paint, Art.px(624f) - listHead.paint.measureText(n))
                val sb = SpannableStringBuilder(name).append(n)
                sb.setSpan(ForegroundColorSpan(Art.INDIGO), name.length, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                listHead.text = sb
            }
            val emptyList = shown.isEmpty()
            libList.visibility = if (emptyList) View.INVISIBLE else View.VISIBLE
            midEmpty.visibility = if (emptyList) View.VISIBLE else View.GONE
            midEmpty.text = if (playlists.isEmpty()) L.t("noListsHow", "app" to L.t("appName")) else L.t("listEmpty")
            plList.visibility = if (playlists.isEmpty()) View.GONE else View.VISIBLE
            plEmpty.visibility = if (playlists.isEmpty()) View.VISIBLE else View.GONE
            plEmpty.text = L.t("noLists")
            // 焦点在一个刚藏起来的地方：挪到还看得见的那一栏
            if (currentFocus?.let { !it.isShown } == true) focusLists()
        }
        updateTags()

        // 顶上的状态：正在唱哪首 / 在等电脑传哪首 / 一共多少首
        val waiting = queue.firstOrNull()?.let { byId(it) }?.takeIf { !it.onTv && current == null }
        val cur = current
        status.text = when {
            cur != null -> twoTone(L.t("nowSinging") + "　", cur.title)
            waiting != null -> "···　" + L.t("waitingFor", "t" to waiting.title)
            else -> L.t("songsCount", "n" to songs.size)
        }
        val address = RemoteServer.localAddress()?.let { "$it:${RemoteServer.PORT}" } ?: ""
        phoneHint.text = address
        qrCard.address = address
        emptyView.address = address

        applyEmpty()
        updateHints()
        // 列表重排以后，把「选中」的样子对回去
        main.post { syncSelected(libList); syncSelected(queueList); syncSelected(plList) }
    }

    /** 前半句灰色、后半句深色（可以大一点） */
    private fun twoTone(grey: String, ink: String, inkSize: Float = 0f): CharSequence {
        val sb = SpannableStringBuilder(grey).append(ink)
        sb.setSpan(ForegroundColorSpan(Art.INK), grey.length, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        if (inkSize > 0f) sb.setSpan(AbsoluteSizeSpan(Art.pxi(inkSize)), grey.length, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        return sb
    }

    /** 栏目小标题：中文拉开字距；英文全大写、更小、字距更开。后面可以跟一个深木色的数字 */
    private fun setLabel(tv: TextView, text: String, count: String?) {
        val en = L.isEnglish
        tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, (if (en) 21f else 24f) * Art.s)
        tv.letterSpacing = if (en) 0.26f else 0.2f
        val head = if (en) text.uppercase() else text
        if (count == null) { tv.text = head; return }
        val sb = SpannableStringBuilder(head).append("　").append(count)
        sb.setSpan(ForegroundColorSpan(Art.INDIGO), head.length, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        tv.text = sb
    }

    /** 一首歌都没有的时候，换成「还没有歌」那一页；有了再换回来 */
    private fun applyEmpty() {
        val empty = songs.isEmpty()
        if (empty == emptyShown) return
        emptyShown = empty
        content.visibility = if (empty) View.GONE else View.VISIBLE
        emptyView.visibility = if (empty) View.VISIBLE else View.GONE
        status.visibility = if (empty) View.INVISIBLE else View.VISIBLE
        headerDivider.visibility = if (empty) View.INVISIBLE else View.VISIBLE
        // 没有歌时没有「我的歌单」可看（歌单里的歌也都没有）
        plChip.visibility = if (empty) View.GONE else View.VISIBLE
        if (empty) stopPreview()
        if (panelVisible && intro == null && langCard.visibility != View.VISIBLE && qrCard.visibility != View.VISIBLE) focusPanel()
    }

    /** 焦点放到点歌页该在的地方：有歌就在歌单，没歌只有「语言」能选 */
    private fun focusPanel() {
        when {
            emptyShown -> phoneChip.requestFocus()
            listsMode -> focusLists()
            else -> libList.requestFocus()
        }
    }

    // ---------- v9：筛选 ----------

    /** 换筛选（或清掉）：歌单回到第一首。已经打的首字母留着 */
    private fun setFilter(f: String) {
        filter = f
        refreshLists()
        libList.setSelection(0)
        schedulePreview()
    }

    /** 从字母键 / 歌单到筛选排：落在选中的那一颗上 */
    private fun toStrip(from: View?) {
        stripReturn = from
        strip.focusIdx = strip.selIdx()
        strip.requestFocus()
        strip.invalidate()
    }

    /** 筛选排按「下」：回到上来的那一栏；歌单是空的就去字母键 */
    private fun stripDown() {
        if (stripReturn === keypad || shown.isEmpty()) keypad.requestFocus() else libList.requestFocus()
    }

    /** 筛选排按确认：普通牌子直接筛，焦点落到歌单第一首；年代 / 歌手打开卡片 */
    private fun chooseChip(i: Int) {
        val c = chips.getOrNull(i) ?: return
        if (c.drawer) { openGrid(c.key); return }
        setFilter(c.key)
        if (shown.isNotEmpty()) libList.requestFocus()
    }

    private fun openGrid(kind: String) {
        val opts = if (kind == Filters.DEC_CHIP) Filters.eraOptions(songs).map { GridCard.Opt(it.first, V9.eraLabel(it.first), it.second) }
            else Filters.artistOptions(songs).map { GridCard.Opt(it.first, it.first, it.second) }
        if (opts.isEmpty()) return
        val prefix = if (kind == Filters.DEC_CHIP) Filters.DEC else Filters.ART
        stopPreview(); previewNote("")   // 卡片压在试听框上，SurfaceView 盖不住，先停掉
        main.removeCallbacks(hideToast); toast.visibility = View.GONE
        gridCard.open(kind, L.t(if (kind == Filters.DEC_CHIP) "fDecade" else "fArtist"), opts, filter.takeIf { it.startsWith(prefix) }?.removePrefix(prefix))
        gridCard.visibility = View.VISIBLE
        gridCard.requestFocus()
        updateHints()
    }

    /** 关掉卡片，什么都不变，焦点回到那颗牌子 */
    private fun closeGrid() {
        gridCard.visibility = View.GONE
        strip.focusIdx = chips.indexOfFirst { it.key == gridCard.kind }.coerceAtLeast(0)
        strip.requestFocus()
        strip.invalidate()
        updateHints()
        if (panelVisible) schedulePreview()
    }

    /** 卡片里按确认：用它筛，卡片关掉，焦点落到歌单第一首 */
    private fun chooseGrid(value: String) {
        val f = (if (gridCard.kind == Filters.DEC_CHIP) Filters.DEC else Filters.ART) + value
        gridCard.visibility = View.GONE
        setFilter(f)
        strip.focusIdx = strip.selIdx()
        if (shown.isNotEmpty()) libList.requestFocus() else strip.requestFocus()
        updateHints()
    }

    // ---------- v9：我的歌单 ----------

    /** 顶栏「我的歌单」按确认：进歌单页；已经在歌单页 = 回点歌页 */
    private fun togglePlaylists() {
        if (!listsMode) { setListsMode(true); focusLists() }
        else { setListsMode(false); if (shown.isNotEmpty()) libList.requestFocus() else keypad.requestFocus() }
    }

    /** 点歌页 ⇄ 歌单页：同一个页面，只换左栏和上面那一排 */
    private fun setListsMode(on: Boolean) {
        listsMode = on
        val pick = if (on) View.GONE else View.VISIBLE
        val lists = if (on) View.VISIBLE else View.GONE
        strip.visibility = pick; stripRule.visibility = pick; queryView.visibility = pick; keypad.visibility = pick
        plHead.visibility = lists; listHead.visibility = lists
        if (on) {
            if (playlists.none { it.id == plId }) plId = playlists.firstOrNull()?.id
        } else {
            plList.visibility = View.GONE; plEmpty.visibility = View.GONE; midEmpty.visibility = View.GONE
            libList.visibility = View.VISIBLE
        }
        (libList.layoutParams as FrameLayout.LayoutParams).topMargin = Art.pxi(if (on) 252f else 264f)
        libList.requestLayout()
        plChip.background = if (on && !plChip.hasFocus()) ChipUnder() else if (plChip.hasFocus()) FocusBlock(bead = false) else null
        refreshLists()
        libList.setSelection(0)
        if (on) plList.setSelection(plIndex())
        schedulePreview()
    }

    /** 歌单页的焦点：左边那张歌单（上次看的那张）；一张都没有就落在「还没有歌单」上（看不出焦点，只能按上、按返回） */
    private fun focusLists() {
        if (playlists.isEmpty()) plEmpty.requestFocus() else { plList.setSelection(plIndex()); plList.requestFocus() }
    }

    /** 歌单页左边换了一张：中间马上跟着换 */
    private fun showPlaylist(i: Int) {
        val p = playlists.getOrNull(i) ?: return
        if (p.id == plId) return
        plId = p.id
        refreshLists()
        libList.setSelection(0)
        schedulePreview()
        (plList.adapter as BaseAdapter).notifyDataSetChanged()
    }

    /** 歌单那一栏里按左 / 右该去哪 */
    private fun focusMiddleOrLeft() {
        when {
            listsMode && shown.isEmpty() -> focusLists()
            else -> libList.requestFocus()
        }
    }

    private fun showPanel() {
        panel.visibility = View.VISIBLE
        refreshLibrary()
        focusPanel()
        schedulePreview()
        updateLyricsVisibility()
        updatePause()
    }

    private fun hidePanel() {
        stopPreview()
        panel.visibility = View.GONE
        root.requestFocus()
        updateLyricsVisibility()
        updatePause()
    }

    /** 底下的按键提示：只写当前这一栏能做什么 */
    private fun updateHints() {
        val ok = L.t("kOk"); val back = L.t("kBack")
        val items = ArrayList<Pair<String, String>>(3)
        val qr = qrCard.visibility == View.VISIBLE
        val lang = langCard.visibility == View.VISIBLE || qr
        when {
            qr -> items += back to L.t("hClose")
            lang -> { items += ok to L.t("hChoose"); items += back to L.t("hClose") }
            langChip.hasFocus() -> items += ok to L.t("language")
            phoneChip.hasFocus() -> items += ok to L.t("phoneChip")
            keypad.hasFocus() -> { items += ok to L.t("hType"); items += back to L.t("hDelLetter") }
            queueList.hasFocus() -> { items += ok to L.t("hTop"); items += L.t("kMenu") to L.t("hRemove") }
            gridCard.visibility == View.VISIBLE -> { items += ok to L.t("hChoose"); items += back to L.t("hClose") }
            plChip.hasFocus() -> items += ok to L.t(if (listsMode) "goPick" else "myLists")
            listsMode && plList.hasFocus() -> { items += ok to L.t("hOpen"); items += back to L.t("goPick") }
            listsMode && libList.hasFocus() -> { items += ok to L.t("hPick"); items += back to L.t("goPick") }
            listsMode -> items += back to L.t("goPick")
            strip.hasFocus() -> { items += ok to L.t("hChoose"); if (filter != Filters.ALL) items += back to L.t("hClearFilter") }
            else -> {
                items += ok to L.t("hPick")
                if (!emptyShown) items += L.t("kMenu") to L.t("hFilter")
                if (filter != Filters.ALL && !emptyShown) items += back to L.t("hClearFilter")
            }
        }
        // 正在唱：返回 = 回到 MV（歌单页、卡片、字母键、有筛选的时候返回键另有用处）
        val backUsed = lang || listsMode || keypad.hasFocus() || gridCard.visibility == View.VISIBLE ||
            (filter != Filters.ALL && (strip.hasFocus() || libList.hasFocus()))
        if (current != null && !backUsed) items += back to L.t("hBackMv")
        hints.set(items)
    }

    // ---------- 语言 ----------

    private fun openLang() {
        langReturn = currentFocus
        langCard.open()
        langCard.visibility = View.VISIBLE
        langCard.requestFocus()
        updateHints()
    }

    private fun closeLang() {
        langCard.visibility = View.GONE
        val back = langReturn?.takeIf { it.visibility == View.VISIBLE && it.isShown } ?: langChip
        back.requestFocus()
        updateHints()
    }

    // ---------- 手机点歌（二维码） ----------

    private fun openQr() {
        stopPreview(); previewNote("")   // 卡片压在试听框上，SurfaceView 盖不住，先停掉
        qrCard.visibility = View.VISIBLE
        qrCard.requestFocus()
        updateHints()
    }

    private fun closeQr() {
        qrCard.visibility = View.GONE
        phoneChip.requestFocus()
        updateHints()
        if (panelVisible) schedulePreview()
    }

    /** 从某一栏的第一行按「上」：记住从哪来，到顶栏的牌子 */
    private fun toChip(chip: View, from: View) { chipReturn = from; chip.requestFocus() }

    private fun chipDown() {
        if (emptyShown) return
        when {
            chipReturn?.isShown == true -> chipReturn?.requestFocus()
            listsMode -> focusLists()
            else -> strip.requestFocus()
        }
    }

    /** 顶栏的牌子：焦点样式一样，左右互换，下回原来那一栏 */
    private fun makeChip(
        textKey: String, onOk: () -> Unit, left: () -> View?, right: () -> View?,
        icon: ListIcon? = null, idle: () -> android.graphics.drawable.Drawable? = { null },
    ) = label(25f, Art.GREY, 0.12f).apply {
        text = L.t(textKey)
        gravity = Gravity.CENTER
        setPadding(Art.pxi(24f), 0, Art.pxi(24f), 0)
        isFocusable = true
        if (icon != null) {
            icon.setBounds(0, 0, icon.intrinsicWidth, icon.intrinsicHeight)
            setCompoundDrawables(icon, null, null, null)
            compoundDrawablePadding = Art.pxi(14f)
        }
        setOnFocusChangeListener { v, has ->
            v.background = if (has) FocusBlock(bead = false) else idle()
            (v as TextView).setTextColor(if (has) Art.FROST else Art.INK)
            icon?.color = if (has) Art.FROST else Art.INK
        }
        setTextColor(Art.INK)
        setOnKeyListener { _, code, e ->
            if (e.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener code in DPAD
            when (code) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> { onOk(); true }
                KeyEvent.KEYCODE_DPAD_DOWN -> { chipDown(); true }
                KeyEvent.KEYCODE_DPAD_LEFT -> { left()?.requestFocus(); true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { right()?.requestFocus(); true }
                KeyEvent.KEYCODE_DPAD_UP -> true
                else -> false
            }
        }
    }

    private fun chooseLang(mode: String) {
        L.set(this, mode)
        relabel()
        closeLang()
    }

    /** 换了语言：所有写死在界面上的字重新取一遍 */
    private fun relabel() {
        lockup.refresh()
        keypad.refresh()
        langChip.text = L.t("language")
        phoneChip.text = L.t("phoneChip")
        plChip.text = L.t("myLists")
        strip.invalidate()
        qrCard.invalidate()
        setLabel(previewCap, L.t("preview"), null)
        showQuery()
        refreshLists()
        emptyView.invalidate()
        pauseCard.invalidate()
        langCard.invalidate()
        if (panelVisible) schedulePreview()
    }

    // ---------- 界面 ----------

    /** 设计稿上的位置和大小（1920×1080 的像素）；宽高给负数就是 MATCH_PARENT(-1) / WRAP_CONTENT(-2) */
    private fun at(x: Float, y: Float, w: Float, h: Float) =
        FrameLayout.LayoutParams(if (w < 0) w.toInt() else Art.pxi(w), if (h < 0) h.toInt() else Art.pxi(h)).apply {
            leftMargin = Art.pxi(x); topMargin = Art.pxi(y)
        }

    /**
     * 太长就截短，结尾用「...」。系统的自动省略号在衬线体里只画成一个点（The Door Teddy Swi.），
     * 所以自己量、自己截。
     */
    private fun fitText(tv: TextView, s: String, maxW: Int) {
        val p = tv.paint
        val room = maxW - tv.paddingLeft - tv.paddingRight
        if (p.measureText(s) <= room) { tv.text = s; return }
        val dots = "..."
        var n = s.length
        while (n > 0 && p.measureText(s, 0, n) + p.measureText(dots) > room) n--
        tv.text = s.substring(0, n).trimEnd() + dots
    }

    private fun label(size: Float, color: Int, spacing: Float = 0f) = TextView(this).apply {
        typeface = Art.font
        setTextSize(TypedValue.COMPLEX_UNIT_PX, size * Art.s)
        setTextColor(color)
        letterSpacing = spacing
        includeFontPadding = false
        setSingleLine()
        ellipsize = TextUtils.TruncateAt.END
    }

    private fun buildUi() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK); isFocusable = true }
        noMv = NoMvView(this).apply { visibility = View.GONE }
        root.addView(noMv, FrameLayout.LayoutParams(-1, -1))
        surface = SurfaceView(this).apply { visibility = View.GONE }
        root.addView(surface, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        lyricsView = LyricsView(this).apply { visibility = View.GONE }
        root.addView(lyricsView, FrameLayout.LayoutParams(-1, -1))
        pauseCard = PauseCard(this).apply { visibility = View.GONE }
        root.addView(pauseCard, FrameLayout.LayoutParams(-1, -1))

        // 点歌页：一整张画好的背景（纸 + 木地板），不透明；左下角再贴一片拉大的叶影
        panel = FrameLayout(this).apply { background = BitmapDrawable(resources, Art.silk(this@MainActivity)).apply { isFilterBitmap = true } }
        panel.addView(ImageView(this).apply { setImageBitmap(Art.leafBitmap()); scaleType = ImageView.ScaleType.FIT_XY }, at(-110f, 470f, 860f, 700f))
        // 最下面的地毯边（叶影不盖在地毯上，所以地毯后加）
        panel.addView(ImageView(this).apply { setImageBitmap(Art.rug(this@MainActivity)); scaleType = ImageView.ScaleType.FIT_XY }, at(0f, 1080f - Art.RUG_H, 1920f, Art.RUG_H))

        // 顶上：标志、状态、手机网址、语言
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        lockup = LockupView(this).apply { refresh() }
        header.addView(lockup, LinearLayout.LayoutParams(-2, -2))
        headerDivider = View(this).apply { setBackgroundColor(Art.LINE) }
        header.addView(headerDivider, LinearLayout.LayoutParams(max(1, Art.pxi(1.5f)), Art.pxi(52f)).apply { leftMargin = Art.pxi(48f); rightMargin = Art.pxi(48f) })
        status = label(28f, Art.GREY, 0.08f)
        header.addView(status, LinearLayout.LayoutParams(0, -2, 1f))
        phoneHint = label(25f, Art.GREY, 0.06f)
        header.addView(phoneHint, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = Art.pxi(30f) })
        // v9：顶栏右边三块牌子 我的歌单 · 手机点歌 · 语言
        plChip = makeChip("myLists", ::togglePlaylists, { null }, { phoneChip }, icon = plIcon, idle = { if (listsMode) ChipUnder() else null })
        header.addView(plChip, LinearLayout.LayoutParams(-2, Art.pxi(58f)).apply { leftMargin = Art.pxi(18f) })
        phoneChip = makeChip("phoneChip", ::openQr, { plChip.takeIf { it.visibility == View.VISIBLE } }, { langChip })
        header.addView(phoneChip, LinearLayout.LayoutParams(-2, Art.pxi(58f)).apply { leftMargin = Art.pxi(12f) })
        langChip = makeChip("language", ::openLang, { phoneChip }, { null })
        header.addView(langChip, LinearLayout.LayoutParams(-2, Art.pxi(58f)).apply { leftMargin = Art.pxi(12f) })
        panel.addView(header, at(96f, 50f, 1728f, 80f))
        // 顶栏下面的一条细线
        panel.addView(View(this).apply { setBackgroundColor(Color.argb(140, 38, 34, 32)) },
            FrameLayout.LayoutParams(Art.pxi(1728f), max(1, Art.pxi(1.5f))).apply { leftMargin = Art.pxi(96f); topMargin = Art.pxi(150f) })

        content = FrameLayout(this)

        // v9：筛选排（只盖左、中两栏 x 96–1296；比 56 高 6px 给焦点的平影）+ 下面一道细线
        strip = FilterStrip(this).apply {
            onUp = { toChip(plChip, strip) }
            onDown = { stripDown() }
            onChoose = { chooseChip(it) }
        }
        content.addView(strip, at(96f, 200f, 1200f, 62f))
        stripRule = View(this).apply { setBackgroundColor(Art.LINE) }
        content.addView(stripRule, FrameLayout.LayoutParams(Art.pxi(1200f), max(1, Art.pxi(1.5f))).apply { leftMargin = Art.pxi(96f); topMargin = Art.pxi(262f) })

        // 左：搜索 + 字母键（v9 往下让了一排）
        queryView = label(27f, Art.GREY, 0.06f).apply { gravity = Gravity.CENTER_VERTICAL; background = Underline(Art.INK, 1.5f) }
        content.addView(queryView, at(96f, 286f, 480f, 66f))
        keypad = KeypadView(this).apply {
            onKey = { k ->
                when (k) {
                    KeypadView.DEL -> setQuery(query.dropLast(1))
                    KeypadView.CLEAR -> setQuery("")
                    else -> setQuery(query + k)
                }
            }
            onExitUp = { toStrip(keypad) }
            onExitRight = { if (shown.isNotEmpty()) libList.requestFocus() }
        }
        content.addView(keypad, at(96f - KeypadView.PAD, 388f - KeypadView.PAD, -2f, -2f))

        // v9 歌单页的左栏：小标题「我的歌单 N」+ 歌单列表（或「还没有歌单」）
        plHead = label(24f, Art.GREY, 0.2f).apply { gravity = Gravity.TOP; background = Underline(Art.LINE, 1.5f); visibility = View.GONE }
        content.addView(plHead, at(96f, 200f, 480f, 50f))
        plList = makeList().apply { visibility = View.GONE }
        plList.adapter = PlaylistAdapter()
        plList.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (listsMode && plList.hasFocus()) showPlaylist(position)   // 上下换一张，中间马上跟着换
                syncSelected(plList)
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
        plList.setOnItemClickListener { _, _, _, _ -> if (shown.isNotEmpty()) { libList.setSelection(0); libList.requestFocus() } }
        plList.setOnKeyListener { _, code, e ->
            if (e.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener false
            when (code) {
                KeyEvent.KEYCODE_DPAD_UP -> if (plList.selectedItemPosition <= 0) { toChip(plChip, plList); true } else false
                KeyEvent.KEYCODE_DPAD_RIGHT -> { if (shown.isNotEmpty()) { libList.setSelection(0); libList.requestFocus() }; true }
                KeyEvent.KEYCODE_DPAD_LEFT -> true
                else -> false
            }
        }
        content.addView(plList, at(96f, 252f, 480f, 676f))
        plEmpty = label(32f, Art.GREY, 0.04f).apply {
            visibility = View.GONE; isFocusable = true
            setOnKeyListener { v, code, e ->
                if (e.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener code in DPAD
                if (code == KeyEvent.KEYCODE_DPAD_UP) toChip(plChip, v)
                code in DPAD
            }
        }
        content.addView(plEmpty, at(114f, 276f, 462f, 48f))

        // 中：歌单（点歌页里没有小标题，筛选排顶替了它；歌单页里是歌单的名字）
        listHead = label(24f, Art.GREY, 0.2f).apply { gravity = Gravity.TOP; background = Underline(Art.LINE, 1.5f); visibility = View.GONE }
        content.addView(listHead, at(672f, 200f, 624f, 50f))
        libList = makeList()
        libList.adapter = SongAdapter()
        libList.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) { schedulePreview(); updateTags(); syncSelected(libList) }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
        libList.setOnItemClickListener { _, _, pos, _ -> shown.getOrNull(pos)?.let { pick(it) } }
        libList.setOnKeyListener { _, code, e ->
            if (e.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener false
            when (code) {
                // 第一行按上：点歌页到筛选排，歌单页到顶栏「我的歌单」
                KeyEvent.KEYCODE_DPAD_UP -> if (libList.selectedItemPosition <= 0) { if (listsMode) toChip(plChip, libList) else toStrip(libList); true } else false
                KeyEvent.KEYCODE_DPAD_LEFT -> { if (listsMode) focusLists() else keypad.requestFocus(); true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { if (queue.isNotEmpty()) queueList.requestFocus(); true }
                else -> false
            }
        }
        content.addView(libList, at(672f, 264f, 624f, 676f))
        midEmpty = ListEmptyView(this).apply { visibility = View.GONE }
        content.addView(midEmpty, at(672f, 252f, 624f, 676f))

        // 右：副歌试听（外面一圈木框，里面就是视频那个矩形）+ 小标签、歌名、一道短线
        val frame = FrameLayout(this).apply { background = OakFrame() }
        previewSurface = SurfaceView(this).apply { visibility = View.INVISIBLE }
        frame.addView(previewSurface, at(16f, 16f, 408f, 230f))
        previewLabel = label(25f, Art.GREY, 0.04f).apply {
            setSingleLine(false); gravity = Gravity.CENTER; setBackgroundColor(Art.PLATE)
            setPadding(Art.pxi(14f), 0, Art.pxi(14f), 0); setLineSpacing(Art.px(8f), 1f)
        }
        frame.addView(previewLabel, at(16f, 16f, 408f, 230f))
        content.addView(frame, at(1384f, 200f, 440f, 268f))
        previewCap = label(24f, Art.GREY, 0.2f).apply { visibility = View.INVISIBLE }
        content.addView(previewCap, at(1384f, 486f, 440f, 32f))
        previewTags = TagLine(this)
        content.addView(previewTags, at(1384f, 486f, 440f, 30f))
        previewTitle = label(34f, Art.INK, 0.04f)
        content.addView(previewTitle, at(1384f, 526f, 440f, 46f))
        content.addView(View(this).apply { setBackgroundColor(Art.INDIGO) }, at(1384f, 592f, 150f, 2f))

        // 右下：已点
        queueHead = label(24f, Art.GREY, 0.2f).apply { gravity = Gravity.TOP; background = Underline(Art.LINE, 1.5f) }
        content.addView(queueHead, at(1384f, 648f, 440f, 50f))
        queueList = makeList()
        queueList.adapter = QueueAdapter()
        queueList.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) = syncSelected(queueList)
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
        queueList.setOnItemClickListener { _, _, pos, _ -> bumpToTop(pos) }
        queueList.setOnKeyListener { _, code, e ->
            if (e.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener false
            when (code) {
                KeyEvent.KEYCODE_DPAD_UP -> if (queueList.selectedItemPosition <= 0) { toChip(langChip, queueList); true } else false
                KeyEvent.KEYCODE_DPAD_LEFT -> { focusMiddleOrLeft(); true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> true
                else -> false
            }
        }
        content.addView(queueList, at(1384f, 700f, 440f, 244f))
        panel.addView(content, FrameLayout.LayoutParams(-1, -1))

        emptyView = EmptyView(this).apply { visibility = View.GONE }
        panel.addView(emptyView, FrameLayout.LayoutParams(-1, -1))

        // 最下面木地板上的按键提示
        hints = HintsView(this)
        panel.addView(hints, at(96f, 967f, 1100f, 42f))   // v9：从 672 挪到 96
        root.addView(panel, FrameLayout.LayoutParams(-1, -1))

        toast = ToastView(this).apply { visibility = View.GONE }
        root.addView(toast, FrameLayout.LayoutParams(-1, Art.pxi(180f)))
        langCard = LangCard(this).apply { visibility = View.GONE; onChoose = ::chooseLang }
        root.addView(langCard, FrameLayout.LayoutParams(-1, -1))
        qrCard = QrCard(this).apply { visibility = View.GONE; onClose = ::closeQr }
        root.addView(qrCard, FrameLayout.LayoutParams(-1, -1))
        gridCard = GridCard(this).apply { visibility = View.GONE; onChoose = ::chooseGrid }
        root.addView(gridCard, FrameLayout.LayoutParams(-1, -1))

        setContentView(root)
        // 焦点一动，按键提示和列表里「选中」的样子跟着变
        root.viewTreeObserver.addOnGlobalFocusChangeListener { _, _ ->
            updateHints()
            syncSelected(libList); syncSelected(queueList); syncSelected(plList)
        }
        setLabel(previewCap, L.t("preview"), null)
        showQuery()
        refreshLists()
    }

    private fun makeList() = ListView(this).apply {
        // 只有遥控器正在操作的那一栏显示焦点牌子
        selector = ColorDrawable(Color.TRANSPARENT)
        setOnFocusChangeListener { v, has ->
            (v as ListView).selector = if (has) FocusBlock() else ColorDrawable(Color.TRANSPARENT)
            syncSelected(v)
        }
        divider = ColorDrawable(Art.LINE)
        dividerHeight = max(1, Art.pxi(1f))
        isFocusable = true
        cacheColorHint = Color.TRANSPARENT
        isVerticalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        // 滚动时行会被重新利用，「焦点行」的样子要跟着对一遍
        setOnScrollListener(object : AbsListView.OnScrollListener {
            override fun onScrollStateChanged(view: AbsListView, scrollState: Int) {}
            override fun onScroll(view: AbsListView, first: Int, visible: Int, total: Int) = syncSelected(view as ListView)
        })
    }

    /**
     * 焦点所在的那一行，字要变成浅色。用 activated 这个状态自己管，不用 selected：
     * 安卓 5 的 ListView 在失去焦点以后重新排版时，还会把那一行标成 selected。
     */
    private fun syncSelected(list: ListView) {
        val has = list.hasFocus()
        val sel = list.selectedItemPosition - list.firstVisiblePosition
        for (i in 0 until list.childCount) list.getChildAt(i).isActivated = has && i == sel
    }

    private fun stateColors(normal: Int, selected: Int) =
        ColorStateList(arrayOf(intArrayOf(android.R.attr.state_activated), intArrayOf()), intArrayOf(selected, normal))

    private val inkColors by lazy { stateColors(Art.INK, Art.FROST) }
    private val greyColors by lazy { stateColors(Art.GREY, Art.SOFT) }
    private val noColors by lazy { stateColors(Art.INDIGO, Art.OAT) }
    private val tagColors by lazy {
        arrayOf(inkColors, stateColors(Art.MID, Art.FROST), stateColors(Art.FROST, Art.FROST), stateColors(Art.INK, Art.FROST), stateColors(Art.GREY, Art.SOFT))
    }

    private fun bindTag(tag: TextView, kind: Int, text: String) {
        (tag.background as TagBg).kind = kind
        tag.text = text
        tag.setTextColor(tagColors[kind])
        tag.visibility = if (kind == TagBg.NONE) View.GONE else View.VISIBLE
        if (kind == TagBg.ON_PC) tag.setPadding(Art.pxi(13f), 0, 0, 0) else tag.setPadding(Art.pxi(13f), 0, Art.pxi(13f), 0)
        tag.invalidate()
    }

    /** 歌单一行：歌名 + 歌手 + 右边小标签（MV / 已点 / 传送中 / 在电脑上） */
    private inner class SongAdapter : BaseAdapter() {
        override fun getCount() = shown.size.coerceAtLeast(1)
        override fun getItem(position: Int): Any? = shown.getOrNull(position)
        override fun getItemId(position: Int) = position.toLong()
        override fun isEnabled(position: Int) = shown.isNotEmpty()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val row = (convertView as? LinearLayout) ?: LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                setPadding(Art.pxi(52f), 0, Art.pxi(22f), 0)
                layoutParams = AbsListView.LayoutParams(-1, Art.pxi(74f))   // v9：76 → 74
                background = RowDot()   // 常点的歌：焦点圆珠的位置上一颗 9px 靛蓝小圆点
                addView(label(40f, Art.INK, 0.02f).apply { maxWidth = Art.pxi(390f) }, LinearLayout.LayoutParams(-2, -2))
                addView(label(25f, Art.GREY, 0.08f).apply { setTextColor(greyColors) }, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = Art.pxi(22f) })
                addView(label(23f, Art.MID, 0.08f).apply { gravity = Gravity.CENTER; background = TagBg() }, LinearLayout.LayoutParams(-2, Art.pxi(38f)))
            }
            val name = row.getChildAt(0) as TextView
            val artist = row.getChildAt(1) as TextView
            val tag = row.getChildAt(2) as TextView
            val song = shown.getOrNull(position)
            (row.background as RowDot).on = song != null && song.id in favRank
            if (song == null) {
                name.text = L.t("noMatch", "q" to query)
                name.setTextColor(Art.GREY)
                name.setTextSize(TypedValue.COMPLEX_UNIT_PX, 32f * Art.s)
                name.maxWidth = Art.pxi(540f)
                artist.text = ""
                bindTag(tag, TagBg.NONE, "")
                return row
            }
            name.text = song.title
            name.setTextColor(inkColors)
            name.setTextSize(TypedValue.COMPLEX_UNIT_PX, 40f * Art.s)
            artist.text = song.artist ?: ""
            val queued = song.id in queue || song.id == current?.id
            when {
                queued && !song.onTv -> bindTag(tag, TagBg.SENDING, L.t("tagSending"))
                queued -> bindTag(tag, TagBg.PICKED, L.t("tagPicked"))
                song.onTv -> if (song.hasVideo) bindTag(tag, TagBg.MV, "MV") else bindTag(tag, TagBg.NONE, "")
                else -> bindTag(tag, TagBg.ON_PC, L.t("tagOnPc"))
            }
            // 歌名最多占多宽：一行 550，先留出标签的位置，有歌手再给歌手留一点
            val tagW = if (tag.visibility == View.GONE) 0 else (tag.paint.measureText(tag.text.toString()) + Art.px(30f)).toInt()
            name.maxWidth = Art.pxi(550f) - tagW - Art.pxi(if (song.artist.isNullOrEmpty()) 22f else 130f)
            fitText(name, song.title, name.maxWidth)
            return row
        }
    }

    /** 歌单页左边一行：歌单名（40px，超出省略号）+ 最右边靛蓝数字（里面几首）。正在看的那张前面一颗 15px 靛蓝圆珠 */
    private inner class PlaylistAdapter : BaseAdapter() {
        override fun getCount() = playlists.size
        override fun getItem(position: Int): Any? = playlists.getOrNull(position)
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val row = (convertView as? LinearLayout) ?: LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                setPadding(Art.pxi(52f), 0, Art.pxi(22f), 0)
                layoutParams = AbsListView.LayoutParams(-1, Art.pxi(74f))
                background = RowDot().apply { radius = 7.5f }
                addView(label(40f, Art.INK, 0.02f).apply { setTextColor(inkColors) }, LinearLayout.LayoutParams(0, -2, 1f))
                addView(label(26f, Art.INDIGO, 0.04f).apply { setTextColor(noColors); gravity = Gravity.END }, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = Art.pxi(16f) })
            }
            val name = row.getChildAt(0) as TextView
            val num = row.getChildAt(1) as TextView
            val p = playlists.getOrNull(position) ?: return row
            val ids = songs.mapTo(HashSet()) { it.id }
            num.text = p.songs.count { it in ids }.toString()
            (row.background as RowDot).on = p.id == plId
            fitText(name, p.name, Art.pxi(480f - 52f - 22f - 16f) - num.paint.measureText(num.text.toString()).toInt())
            return row
        }
    }

    /** 已点一行：编号 + 歌名 +（还在传的）「传送中」 */
    private inner class QueueAdapter : BaseAdapter() {
        override fun getCount() = queue.size.coerceAtLeast(1)
        override fun getItem(position: Int): Any? = queue.getOrNull(position)
        override fun getItemId(position: Int) = position.toLong()
        override fun isEnabled(position: Int) = queue.isNotEmpty()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val row = (convertView as? LinearLayout) ?: LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                setPadding(Art.pxi(50f), 0, Art.pxi(14f), 0)
                layoutParams = AbsListView.LayoutParams(-1, Art.pxi(60f))
                addView(label(24f, Art.INDIGO, 0.08f).apply { setTextColor(noColors) }, LinearLayout.LayoutParams(Art.pxi(50f), -2))
                addView(label(31f, Art.INK, 0.02f), LinearLayout.LayoutParams(0, -2, 1f))
                addView(label(20f, Art.INK, 0.06f).apply { gravity = Gravity.CENTER; background = TagBg() }, LinearLayout.LayoutParams(-2, Art.pxi(32f)).apply { leftMargin = Art.pxi(10f) })
            }
            val no = row.getChildAt(0) as TextView
            val name = row.getChildAt(1) as TextView
            val tag = row.getChildAt(2) as TextView
            val song = queue.getOrNull(position)?.let { byId(it) }
            row.setPadding(Art.pxi(if (queue.isEmpty()) 6f else 50f), 0, Art.pxi(14f), 0)
            if (queue.isEmpty()) {
                no.visibility = View.GONE
                name.text = L.t("queueEmpty")
                name.setTextColor(Art.GREY)
                bindTag(tag, TagBg.NONE, "")
                return row
            }
            no.visibility = View.VISIBLE
            no.text = if (position < 9) "0${position + 1}" else "${position + 1}"
            name.text = song?.title ?: ""
            name.setTextColor(inkColors)
            if (song != null && !song.onTv) bindTag(tag, TagBg.SENDING, L.t("tagSending")) else bindTag(tag, TagBg.NONE, "")
            // 这一栏 440 宽：去掉左右留白、编号，再给标签留位置
            val tagW = if (tag.visibility == View.GONE) 0 else (tag.paint.measureText(tag.text.toString()) + Art.px(40f)).toInt()
            fitText(name, song?.title ?: "", Art.pxi(440f - 50f - 14f - 50f) - tagW)
            return row
        }
    }

    // ---------- 消息条 ----------

    private val hideToast = Runnable { toast.visibility = View.GONE }

    /** 出一条消息：一行或两行字；[err] 是出错的样子 */
    private fun flash(msg: String, sub: String? = null, err: Boolean = false, ms: Long = 2000) {
        toast.text(msg, sub, err)
        showToast(ms)
    }

    /** 点歌页开着：消息条在木地板上方；唱歌时：在屏幕上方，不挡歌词 */
    private fun showToast(ms: Long) {
        val lp = toast.layoutParams as FrameLayout.LayoutParams
        val top = Art.pxi(if (panelVisible) 790f else 64f)
        if (lp.topMargin != top) { lp.topMargin = top; toast.layoutParams = lp }
        toast.visibility = View.VISIBLE
        main.removeCallbacks(hideToast)
        if (ms > 0) main.postDelayed(hideToast, ms)
    }

    companion object {
        const val TAG = "BanzouKTV"
        private val DPAD = intArrayOf(
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER,
        )
    }
}
