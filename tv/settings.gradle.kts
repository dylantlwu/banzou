pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories {
    // google() 只找安卓自己的库；其他（比如二维码 zxing）去 Maven Central
    google { content { includeGroupByRegex("androidx\\..*|com\\.android.*|com\\.google\\.android.*") } }
    mavenCentral()
} }
rootProject.name = "BanzouKTV"
include(":app")
