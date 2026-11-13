package com.banzou.ktv

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * 设计稿 v6（清冷 + 木地板）的颜色、尺寸和几样共用的画法。
 * 设计稿按 1920×1080 画，这里的 [s] 把设计稿的像素换成这台电视的像素。
 */
object Art {
    val PAPER = Color.parseColor("#E8E7E4")      // 银珠色：丝绸背景的中间色；没有图的地方平涂它
    val CARD = Color.parseColor("#F3F1EC")       // 卡片（歌名、暂停、语言）
    val PLATE = Color.parseColor("#D2CEC7")      // 没有画面时的试听框、空状态的图版
    val LINE = Color.parseColor("#CBC6BE")       // 细线
    val KEYLINE = Color.parseColor("#BDB8B0")    // 字母键的格线
    val INK = Color.parseColor("#262220")        // 主文字、焦点、消息条（铁艺桌子的炭黑）
    val SLATE = Color.parseColor("#26282A")      // 暗场：开场、没有 MV 的画面
    val GREY = Color.parseColor("#7E7C78")       // 次要文字
    val MID = Color.parseColor("#77797C")        // MV 标签的细框
    val SILVER = Color.parseColor("#B4B7BA")     // 深色上的细线、徽记
    val SOFT = Color.parseColor("#B9BBBD")       // 深色上的次要文字
    val FROST = Color.parseColor("#F4F4F1")      // 深色上的字
    val CLAY = Color.parseColor("#C79A90")       // 出错
    val HINT = Color.parseColor("#2B3446")       // 地毯素边上的按键提示（深靛蓝）
    val HINT_LINE = Color.parseColor("#3A4458")
    // v8：地毯的颜色。靛蓝 = 浅色上的点缀；燕麦色 = 深色上的点缀
    val INDIGO = Color.parseColor("#3A4458")
    val INDIGO_DEEP = Color.parseColor("#2B3446")
    val CREAM = Color.parseColor("#E6DED0")
    val OAT = Color.parseColor("#D9CFBE")
    val LYRIC = Color.parseColor("#F7F7F4")      // 歌词：没唱到
    val LYRIC_SUNG = Color.parseColor("#9DD0F0") // 歌词：唱过（冰蓝）
    val LYRIC_EDGE = Color.parseColor("#1E1F21") // 歌词描边

    /** 设计稿 1px = 屏幕上多少 px */
    var s = 1f
        private set
    var W = 1920
        private set
    var H = 1080
        private set

    /** 拉丁字母和数字用衬线体，中文自动落到系统黑体 */
    val font: Typeface = Typeface.SERIF

    fun init(ctx: Context) {
        val dm = ctx.resources.displayMetrics
        W = max(dm.widthPixels, dm.heightPixels)
        H = min(dm.widthPixels, dm.heightPixels)
        s = min(W / 1920f, H / 1080f)
    }

    fun px(v: Float) = v * s
    fun pxi(v: Float) = (v * s).roundToInt()

    fun textPaint(size: Float, color: Int, spacing: Float = 0f) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = font
        textSize = size * s
        this.color = color
        letterSpacing = spacing
    }

    /** 固定的「随机」数（和设计稿里的算法一样），每次画出来都一样 */
    fun rnd(i: Int): Float {
        val v = sin(i * 127.1 + 311.7) * 43758.5453
        return (v - floor(v)).toFloat()
    }

    // ---------- 点歌页的整张背景：纸 + 最下面一段木地板。只画一次 ----------

    private var panelBg: Bitmap? = null

    /** 丝绸背景：一张 480×270 的小图（ARGB_8888，不然会出色带），拉满整屏时由显卡双线性放大，更柔 */
    fun silk(ctx: android.content.Context): Bitmap = panelBg ?: ctx.assets.open("silk-480x270.png").use {
        BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 })!!
    }.also { panelBg = it }

    private var rugBm: Bitmap? = null

    /** 最下面的地毯边（1920×132，上面米白素边、下面一排靛蓝菱形），原大贴在 y=948 */
    fun rug(ctx: android.content.Context): Bitmap = rugBm ?: ctx.assets.open("rug-1920x132.png").use {
        BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.RGB_565 })!!
    }.also { rugBm = it }

    /** 地毯带的高度（设计稿像素） */
    const val RUG_H = 132f

    /**
     * 叶影：一张 96×96 的小图（四片斜的椭圆，抹虚）。用的时候拉大贴在左下角——拉大由显卡做，又快又平滑。
     * 不画进背景图：背景图是 RGB_565，这么淡的渐变画进去会有一圈一圈的色带。
     */
    fun leafBitmap(): Bitmap {
        val n = 96
        val small = Bitmap.createBitmap(n, n, Bitmap.Config.ARGB_8888)
        val sc = Canvas(small)
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(51, 44, 48, 58) }
        val oval = RectF()
        val leaves = floatArrayOf(20f, 72f, 36f, 7.5f, -0.62f, 32f, 86f, 38f, 6.5f, -0.28f, 6f, 56f, 26f, 5.5f, -1.0f, 42f, 99f, 32f, 5.5f, -0.08f)
        for (i in 0 until 4) {
            val x = leaves[i * 5]; val y = leaves[i * 5 + 1]; val rx = leaves[i * 5 + 2]; val ry = leaves[i * 5 + 3]
            sc.save()
            sc.rotate(Math.toDegrees(leaves[i * 5 + 4].toDouble()).toFloat(), x, y)
            oval.set(x - rx, y - ry, x + rx, y + ry)
            sc.drawOval(oval, p)
            sc.restore()
        }
        // 抹虚：对透明度做六遍小范围平均（只在生成背景图时做一次）
        val pix = IntArray(n * n)
        small.getPixels(pix, 0, n, 0, 0, n, n)
        var a = IntArray(n * n) { pix[it] ushr 24 }
        var t = IntArray(n * n)
        repeat(6) {
            for (y in 0 until n) for (x in 0 until n) {
                var sum = 0; var cnt = 0
                for (dy in -3..3) for (dx in -3..3) {
                    val xx = x + dx; val yy = y + dy
                    if (xx in 0 until n && yy in 0 until n) { sum += a[yy * n + xx]; cnt++ }
                }
                t[y * n + x] = sum / cnt
            }
            val swap = a; a = t; t = swap
        }
        for (i in pix.indices) pix[i] = Color.argb(a[i], 44, 48, 58)
        small.setPixels(pix, 0, n, 0, 0, n, n)
        return small
    }

    // ---------- 暗场的背景：深石板色 + 上方一片很淡的冷光。画一次（半尺寸，放大用，免得有色带） ----------

    private var roomBg: Bitmap? = null

    fun roomBackground(): Bitmap = roomBg ?: Bitmap.createBitmap(W / 2, H / 2, Bitmap.Config.ARGB_8888).also { b ->
        val c = Canvas(b)
        c.drawColor(SLATE)
        val cx = b.width / 2f; val cy = b.height * 0.33f; val r = b.width * 0.42f
        val p = Paint(Paint.ANTI_ALIAS_FLAG or Paint.DITHER_FLAG)
        p.shader = RadialGradient(cx, cy, r, Color.argb(22, 255, 255, 255), Color.argb(0, 255, 255, 255), Shader.TileMode.CLAMP)
        c.drawCircle(cx, cy, r, p)
        roomBg = b
    }
}

/**
 * 徽记：一圈 12 颗珠子，11 颗透明（只有细线），左上方 1 颗木珠（实心）。
 * 按 100×100 的格子算位置。画的时候不新建任何对象。
 */
class Emblem {
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val box = RectF()

    /** 整个徽记。[size] 是边长；[sw] 是线的粗细（按 100 的格子算）；[glass] 大尺寸时加高光 */
    fun draw(c: Canvas, left: Float, top: Float, size: Float, line: Int, sw: Float, solid: Int, glass: Boolean = false, alpha: Int = 255) {
        val u = size / 100f
        for (i in 0 until N) bead(c, left + X[i] * u, top + Y[i] * u, R * u, line, sw * u, i == SOLID, solid, glass, alpha)
    }

    /** 一颗珠子 */
    fun bead(c: Canvas, x: Float, y: Float, r: Float, line: Int, lw: Float, isSolid: Boolean, solid: Int, glass: Boolean, alpha: Int) {
        if (isSolid) {
            fill.color = solid; fill.alpha = alpha
            c.drawCircle(x, y, r, fill)
            if (glass) {
                stroke.color = Color.WHITE; stroke.alpha = alpha * 140 / 255; stroke.strokeWidth = lw * 1.2f
                box.set(x - r * 0.63f, y - r * 0.63f, x + r * 0.63f, y + r * 0.63f)
                c.drawArc(box, 200f, 76f, false, stroke)
            }
            return
        }
        if (glass) { fill.color = Color.WHITE; fill.alpha = alpha * 13 / 255; c.drawCircle(x, y, r, fill) }
        stroke.color = line; stroke.alpha = alpha; stroke.strokeWidth = lw
        c.drawCircle(x, y, r, stroke)
        if (glass) {
            stroke.strokeWidth = lw * 0.8f
            box.set(x - r * 0.63f, y - r * 0.63f, x + r * 0.63f, y + r * 0.63f)
            c.drawArc(box, 195f, 72f, false, stroke)
            fill.color = line; fill.alpha = alpha * 180 / 255
            c.drawCircle(x + r * 0.36f, y + r * 0.38f, r * 0.12f, fill)
        }
    }

    companion object {
        const val N = 12
        const val SOLID = 10
        const val R = 7.3f
        val X = FloatArray(N) { 50f + (cos(it / N.toDouble() * Math.PI * 2 - Math.PI / 2) * 33).toFloat() }
        val Y = FloatArray(N) { 50f + (sin(it / N.toDouble() * Math.PI * 2 - Math.PI / 2) * 33).toFloat() }
    }
}

/** 焦点：一块炭黑的牌子，里面一圈木色细线，（歌单里）左边一颗木色小圆珠，下面一道平涂的影子 */
class FocusBlock(private val bead: Boolean = true) : Drawable() {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Art.OAT; alpha = 230; strokeWidth = Art.px(2f) }

    override fun draw(c: Canvas) {
        val b = bounds
        val s = Art.s
        fill.color = Color.argb(26, 40, 40, 42)
        c.drawRect(b.left.toFloat(), b.top + 5 * s, b.right.toFloat(), b.bottom + 5 * s, fill)
        fill.color = Art.INK
        c.drawRect(b.left.toFloat(), b.top.toFloat(), b.right.toFloat(), b.bottom.toFloat(), fill)
        c.drawRect(b.left + 6 * s, b.top + 6 * s, b.right - 6 * s, b.bottom - 6 * s, line)
        if (bead) {
            fill.color = Art.OAT
            c.drawCircle(b.left + 28 * s, b.exactCenterY(), 7.5f * s, fill)
        }
    }

    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(cf: ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}

/** 一条底线（搜索框、栏目标题） */
class Underline(color: Int, private val thick: Float) : Drawable() {
    private val p = Paint().apply { this.color = color }
    override fun draw(c: Canvas) {
        val b = bounds
        c.drawRect(b.left.toFloat(), b.bottom - thick * Art.s, b.right.toFloat(), b.bottom.toFloat(), p)
    }
    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(cf: ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}

/** 试听外面的木框：一圈木色 + 一圈纸色留白，下面一道很淡的影子 */
class OakFrame : Drawable() {
    private val p = Paint()
    override fun draw(c: Canvas) {
        val b = bounds
        val s = Art.s
        val bottom = b.bottom - 6 * s
        p.color = Color.argb(20, 43, 52, 70)
        c.drawRect(b.left.toFloat(), b.top + 6 * s, b.right.toFloat(), b.bottom.toFloat(), p)
        p.color = Art.INDIGO                                   // v8：4px 靛蓝
        c.drawRect(b.left.toFloat(), b.top.toFloat(), b.right.toFloat(), bottom, p)
        p.color = Art.CARD                                     // 卡片色留白（背景是丝绸图，留白要有自己的颜色）
        c.drawRect(b.left + 4 * s, b.top + 4 * s, b.right - 4 * s, bottom - 4 * s, p)
    }
    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(cf: ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}

/** 行尾的小标签的底：MV 细框 / 已点 实底 / 传送中 虚线框 / 在电脑上 什么都没有。焦点所在的行（activated）里都变成浅色细框 */
class TagBg : Drawable() {
    var kind = NONE
    private val fill = Paint()
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = Art.px(1.5f) }
    private val dash = DashPathEffect(floatArrayOf(Art.px(5f), Art.px(4f)), 0f)
    private var selected = false

    override fun isStateful() = true
    override fun onStateChange(state: IntArray): Boolean {
        val sel = state.contains(android.R.attr.state_activated)
        if (sel == selected) return false
        selected = sel
        invalidateSelf()
        return true
    }

    override fun draw(c: Canvas) {
        if (kind == NONE || kind == ON_PC) return
        val b = bounds
        val h = line.strokeWidth / 2
        if (kind == PICKED && !selected) {
            fill.color = Art.INDIGO
            c.drawRect(b.left.toFloat(), b.top.toFloat(), b.right.toFloat(), b.bottom.toFloat(), fill)
            return
        }
        line.color = if (selected) Art.FROST else Art.MID
        line.alpha = if (selected) 115 else 255
        line.pathEffect = if (kind == SENDING && !selected) dash else null
        c.drawRect(b.left + h, b.top + h, b.right - h, b.bottom - h, line)
    }

    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(cf: ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT

    companion object {
        const val NONE = 0
        const val MV = 1
        const val PICKED = 2
        const val SENDING = 3
        const val ON_PC = 4
    }
}
