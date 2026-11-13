package com.banzou.ktv

import android.util.Log
import java.io.BufferedInputStream
import java.io.InputStream
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder

/**
 * 手机 / iPad 遥控：电视上开一个很小的网页服务，同一个网络里的设备用浏览器打开
 * http://电视IP:8288 就能点歌、切歌、分别调伴奏和人声的音量。不用装任何东西。
 *
 * GET /            遥控网页（assets/remote.html）
 * GET /api/state   当前状态（JSON）
 * GET /api/do?c=命令&i=序号&v=数值   执行命令，返回新的状态
 */
class RemoteServer(
    private val page: () -> ByteArray,
    /** 在主线程里执行，返回状态 JSON */
    private val handle: (cmd: String?, params: Map<String, String>) -> String,
) {
    private var server: ServerSocket? = null

    fun start() {
        Thread {
            try {
                val s = ServerSocket(PORT)
                server = s
                while (!s.isClosed) {
                    val c = s.accept()
                    Thread { serve(c) }.start()
                }
            } catch (e: Exception) {
                Log.w(TAG, "remote server stopped: $e")
            }
        }.apply { isDaemon = true }.start()
    }

    fun stop() {
        try { server?.close() } catch (_: Exception) {}
    }

    private fun serve(c: Socket) {
        c.use { sock ->
            try {
                sock.soTimeout = 5000
                val input = BufferedInputStream(sock.getInputStream())
                val requestLine = readLine(input) ?: return
                while (true) { val h = readLine(input) ?: break; if (h.isEmpty()) break }
                val target = requestLine.split(" ").getOrNull(1) ?: "/"
                val path = target.substringBefore('?')
                val query = target.substringAfter('?', "").split('&').filter { it.contains('=') }
                    .associate { URLDecoder.decode(it.substringBefore('='), "UTF-8") to URLDecoder.decode(it.substringAfter('='), "UTF-8") }
                val (type, body) = when (path) {
                    "/", "/index.html" -> "text/html; charset=utf-8" to page()
                    "/api/state" -> "application/json; charset=utf-8" to handle(null, query).toByteArray()
                    "/api/do" -> "application/json; charset=utf-8" to handle(query["c"], query).toByteArray()
                    else -> {
                        respond(sock, "404 Not Found", "text/plain", "not found".toByteArray()); return
                    }
                }
                respond(sock, "200 OK", type, body)
            } catch (e: Exception) {
                Log.w(TAG, "request failed: $e")
            }
        }
    }

    private fun respond(sock: Socket, status: String, type: String, body: ByteArray) {
        val head = "HTTP/1.0 $status\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        sock.getOutputStream().apply { write(head.toByteArray()); write(body); flush() }
    }

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(b.toChar())
            if (sb.length > 8192) return null
        }
    }

    companion object {
        const val PORT = 8288
        const val TAG = "RemoteServer"

        /** 电视在局域网里的地址（有线或无线），给屏幕上显示遥控网址用 */
        fun localAddress(): String? = try {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.toList() }
                .firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
                ?.hostAddress
        } catch (_: Exception) { null }
    }
}
