package com.banzou.ktv

import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.BaseAudioProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * 歌曲文件的声音是 4 声道：[伴奏左, 伴奏右, 人声左, 人声右]。
 * 这里把它混成立体声，伴奏和人声的音量可以分别随时调（伴唱 = 人声 0），
 * 两者是同一路声音，所以切换没有停顿、也不会错位。
 */
class VocalMixer : BaseAudioProcessor() {
    @Volatile var targetGain = 0f
    @Volatile var targetMusic = 1f
    private var gain = 0f
    private var music = 1f
    private val step = 1f / 4410f // 约 0.1 秒淡入淡出，切换不爆音

    override fun onConfigure(inputAudioFormat: AudioFormat): AudioFormat {
        Log.i(TAG, "input format: $inputAudioFormat")
        if (inputAudioFormat.channelCount != 4 || inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) {
            return AudioFormat.NOT_SET // 不是 4 声道就原样放
        }
        return AudioFormat(inputAudioFormat.sampleRate, 2, C.ENCODING_PCM_16BIT)
    }

    override fun queueInput(input: ByteBuffer) {
        val n = input.remaining() / 8
        val out = replaceOutputBuffer(n * 4)
        input.order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until n) {
            val al = input.short.toInt()
            val ar = input.short.toInt()
            val vl = input.short.toInt()
            val vr = input.short.toInt()
            if (gain < targetGain) gain = minOf(targetGain, gain + step)
            else if (gain > targetGain) gain = maxOf(targetGain, gain - step)
            if (music < targetMusic) music = minOf(targetMusic, music + step)
            else if (music > targetMusic) music = maxOf(targetMusic, music - step)
            out.putShort(clip(music * al + gain * vl))
            out.putShort(clip(music * ar + gain * vr))
        }
        out.flip()
    }

    override fun onReset() {
        gain = targetGain
        music = targetMusic
    }

    private fun clip(v: Float): Short = v.toInt().coerceIn(-32768, 32767).toShort()

    companion object { const val TAG = "VocalMixer" }
}
