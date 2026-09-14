package settings

// UIConfig returns the language-neutral form metadata used by the Node
// settings form. Keeping this table in the shared Go package means the Go
// read service can serve the admin settings screen without calling back into
// Node. The persisted setting schema remains authoritative for values and
// labels; this table only describes presentation and validation hints.
func UIConfig(namespace, key string) map[string]any {
	config := map[string]any{}
	switch namespace {
	case "app":
		switch key {
		case "title":
			config = map[string]any{"type": "input", "placeholder": "ChronoFrame", "required": true}
		case "slogan":
			config = map[string]any{"type": "input", "placeholder": "Your gallery slogan", "help": "settings.app.slogan.help"}
		case "author":
			config = map[string]any{"type": "input", "placeholder": "Your name"}
		case "avatarUrl":
			config = map[string]any{"type": "url", "placeholder": "https://example.com/avatar.jpg", "help": "settings.app.avatarUrl.help"}
		case "appearance.theme":
			config = map[string]any{
				"type": "tabs",
				"options": []map[string]any{
					{"label": "settings.app.appearance.theme.light", "value": "light", "icon": "tabler:sun"},
					{"label": "settings.app.appearance.theme.dark", "value": "dark", "icon": "tabler:moon"},
					{"label": "settings.app.appearance.theme.system", "value": "system", "icon": "tabler:device-desktop"},
				},
				"help": "settings.app.appearance.theme.help",
			}
		}
	case "map":
		switch key {
		case "provider":
			config = map[string]any{
				"type": "tabs",
				"options": []map[string]any{
					{"label": "MapBox", "value": "mapbox"},
					{"label": "MapLibre", "value": "maplibre"},
					{"label": "AMap", "value": "amap"},
				},
			}
		case "mapbox.token":
			config = visiblePassword("pk.xxxxxx", "provider", "mapbox", "settings.map.mapbox.token.help", true)
		case "mapbox.style":
			config = visibleInput("mapbox://styles/mapbox/light-v11", "provider", "mapbox")
		case "maplibre.token":
			config = visiblePassword("pk.xxxxxx", "provider", "maplibre", "settings.map.maplibre.token.help", true)
		case "maplibre.style":
			config = visibleInput("https://example.com/style.json", "provider", "maplibre")
		case "amap.key":
			config = visiblePassword("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "provider", "amap", "settings.map.amap.key.help", true)
		case "amap.securityJsCode":
			config = visiblePassword("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "provider", "amap", "settings.map.amap.securityJsCode.help", true)
		}
	case "location":
		switch key {
		case "provider":
			config = map[string]any{
				"type": "select",
				"options": []map[string]any{
					{"label": "settings.location.provider.options.auto", "value": "auto"},
					{"label": "settings.location.provider.options.amap", "value": "amap"},
					{"label": "settings.location.provider.options.mapbox", "value": "mapbox"},
					{"label": "settings.location.provider.options.nominatim", "value": "nominatim"},
				},
			}
		case "language":
			config = map[string]any{
				"type": "select",
				"options": []map[string]any{
					{"label": "简体中文 (Simplified Chinese)", "value": "zh-Hans"},
					{"label": "繁體中文 (Traditional Chinese, Taiwan)", "value": "zh-Hant-TW"},
					{"label": "繁體中文 (Traditional Chinese, Hong Kong)", "value": "zh-Hant-HK"},
					{"label": "English", "value": "en"},
					{"label": "日本語 (Japanese)", "value": "ja"},
					{"label": "Русский (Russian)", "value": "ru"},
				},
				"help": "settings.location.language.help",
			}
		case "mapbox.token":
			config = visiblePassword("pk.xxxxxx", "provider", "mapbox", "settings.location.mapbox.token.help", false)
		case "nominatim.baseUrl":
			config = visibleInput("https://nominatim.openstreetmap.org", "provider", "nominatim")
			config["type"] = "url"
			config["help"] = "settings.location.nominatim.baseUrl.help"
		case "amap.webServiceKey":
			config = visiblePassword("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "provider", "amap", "settings.location.amap.webServiceKey.help", true)
		}
	case "privacy":
		if key == "upload.autoEraseLocation" {
			config = map[string]any{"type": "toggle", "help": "settings.privacy.upload.autoEraseLocation.help"}
		}
	case "analytics":
		switch key {
		case "headScripts":
			config = map[string]any{"type": "textarea", "rows": 12, "placeholder": "<!-- Google Analytics -->\n<script async src=\"https://www.googletagmanager.com/gtag/js?id=G-XXXX\"></script>\n<script>\n  window.dataLayer = window.dataLayer || [];\n  function gtag(){dataLayer.push(arguments);}\n  gtag('js', new Date());\n  gtag('config', 'G-XXXX');\n</script>", "help": "settings.analytics.headScripts.help"}
		case "bodyScripts":
			config = map[string]any{"type": "textarea", "rows": 12, "placeholder": "<!-- Umami / Openpanel SDK -->\n<script src=\"https://analytics.example.com/script.js\" data-website-id=\"xxx\" defer></script>", "help": "settings.analytics.bodyScripts.help"}
		}
	case "site":
		switch key {
		case "icpNumber":
			config = map[string]any{"type": "input", "placeholder": "京ICP备12345678号", "help": "settings.site.icpNumber.help"}
		case "policeNumber":
			config = map[string]any{"type": "input", "placeholder": "11010502000001", "help": "settings.site.policeNumber.help"}
		case "customHeader", "customFooter":
			config = map[string]any{"type": "textarea", "rows": 6, "placeholder": "<!-- 自定义 footer HTML，例如版权声明、友情链接 -->"}
			if key == "customHeader" {
				config["placeholder"] = "<!-- 自定义 header HTML，例如公告条、顶部 banner -->"
			}
			config["help"] = "settings.site." + key + ".help"
		}
	case "system":
		config = systemUIConfig(key)
	case "storage":
		config = storageUIConfig(key)
	}
	if len(config) == 0 {
		return map[string]any{"type": "input", "required": false}
	}
	return config
}

func visibleInput(placeholder, fieldKey, value string) map[string]any {
	return map[string]any{
		"type":        "input",
		"placeholder": placeholder,
		"visibleIf":   map[string]any{"fieldKey": fieldKey, "value": value},
	}
}

func visiblePassword(placeholder, fieldKey, value, help string, required bool) map[string]any {
	config := map[string]any{
		"type":        "password",
		"placeholder": placeholder,
		"visibleIf":   map[string]any{"fieldKey": fieldKey, "value": value},
	}
	if required {
		config["required"] = true
	}
	if help != "" {
		config["help"] = help
	}
	return config
}

func systemUIConfig(key string) map[string]any {
	switch key {
	case "backend.readProvider":
		return map[string]any{
			"type": "tabs",
			"options": []map[string]any{
				{"label": "settings.system.backend.readProvider.options.node", "value": "node", "icon": "tabler:brand-nodejs"},
				{"label": "settings.system.backend.readProvider.options.go", "value": "go", "icon": "tabler:brand-golang"},
			},
			"help": "settings.system.backend.readProvider.help",
		}
	case "upload.maxFileSize":
		return map[string]any{"type": "number", "help": "settings.app.upload.maxFileSize.help", "min": 1, "max": 10240}
	case "upload.duplicateCheck.enabled":
		return map[string]any{"type": "toggle", "help": "settings.system.upload.duplicateCheck.enabled.help"}
	case "upload.duplicateCheck.mode":
		return map[string]any{
			"type": "tabs",
			"options": []map[string]any{
				{"label": "settings.system.upload.duplicateCheck.mode.options.skip", "value": "skip", "icon": "tabler:player-track-next"},
				{"label": "settings.system.upload.duplicateCheck.mode.options.warn", "value": "warn", "icon": "tabler:alert-triangle"},
				{"label": "settings.system.upload.duplicateCheck.mode.options.block", "value": "block", "icon": "tabler:ban"},
			},
			"help": "settings.system.upload.duplicateCheck.mode.help",
		}
	case "webglImageViewerDebug":
		return map[string]any{"type": "toggle", "help": "settings.system.webglImageViewerDebug.help"}
	case "auth.github.enabled":
		return map[string]any{"type": "toggle"}
	case "auth.github.clientId":
		return map[string]any{"type": "input", "placeholder": "Ov23li...", "visibleIf": map[string]any{"fieldKey": "auth.github.enabled", "value": true}}
	case "auth.github.clientSecret":
		return map[string]any{"type": "password", "placeholder": "github_oauth_client_secret", "visibleIf": map[string]any{"fieldKey": "auth.github.enabled", "value": true}}
	case "backup.enabled":
		return map[string]any{"type": "toggle", "help": "settings.system.backup.enabled.help"}
	case "backup.cron":
		return map[string]any{"type": "input", "placeholder": "0 3 * * *", "help": "settings.system.backup.cron.help"}
	case "backup.timezone":
		return map[string]any{"type": "input", "placeholder": "Asia/Shanghai", "help": "settings.system.backup.timezone.help"}
	case "backup.retentionDays":
		return map[string]any{"type": "number", "min": 1, "max": 3650, "help": "settings.system.backup.retentionDays.help"}
	case "backup.smtpHost":
		return map[string]any{"type": "input", "placeholder": "smtp.example.com", "help": "settings.system.backup.smtpHost.help"}
	case "backup.smtpPort":
		return map[string]any{"type": "number", "min": 1, "max": 65535}
	case "backup.smtpSecure":
		return map[string]any{"type": "toggle"}
	case "backup.smtpUser":
		return map[string]any{"type": "input", "placeholder": "your-email@example.com"}
	case "backup.smtpPassword":
		return map[string]any{"type": "password", "placeholder": "SMTP password or app password"}
	case "backup.mailFrom":
		return map[string]any{"type": "input", "placeholder": "ChronoFrame <your-email@example.com>", "help": "settings.system.backup.mailFrom.help"}
	case "backup.mailTo":
		return map[string]any{"type": "input", "placeholder": "your-email@example.com", "help": "settings.system.backup.mailTo.help"}
	case "backup.encryptionPassphrase":
		return map[string]any{"type": "password", "placeholder": "Optional encryption passphrase", "help": "settings.system.backup.encryptionPassphrase.help"}
	}
	return nil
}

func storageUIConfig(key string) map[string]any {
	if key == "provider" {
		return map[string]any{
			"type": "custom",
			"options": []map[string]any{
				{"label": "settings.storage.provider.options.local.label", "value": "local", "icon": "tabler:server", "description": "settings.storage.provider.options.local.description"},
				{"label": "settings.storage.provider.options.s3.label", "value": "s3", "icon": "tabler:brand-aws", "description": "settings.storage.provider.options.s3.description"},
				{"label": "settings.storage.provider.options.openlist.label", "value": "openlist", "icon": "tabler:stack", "description": "settings.storage.provider.options.openlist.description"},
			},
		}
	}
	if key == "name" {
		return map[string]any{"type": "input", "required": true}
	}
	const (
		local    = "local"
		s3       = "s3"
		openlist = "openlist"
	)
	switch key {
	case "local.basePath":
		return storageVisible("input", "", local, true, "settings.storage.local.basePath.description")
	case "local.baseUrl":
		return storageVisible("input", "", local, false, "settings.storage.local.baseUrl.description")
	case "local.prefix":
		config := visibleInput("photos/", "provider", local)
		config["help"] = "settings.storage.local.prefix.description"
		return config
	case "s3.endpoint":
		return storageVisible("input", "https://s3.amazonaws.com", "s3", true, "settings.storage.s3.endpoint.description")
	case "s3.bucket":
		return storageVisible("input", "", "s3", true, "settings.storage.s3.bucket.description")
	case "s3.region":
		return storageVisible("input", "", "s3", true, "settings.storage.s3.region.description")
	case "s3.accessKeyId":
		return storageVisible("input", "", "s3", true, "settings.storage.s3.accessKeyId.description")
	case "s3.secretAccessKey":
		return storageVisible("password", "", "s3", true, "settings.storage.s3.secretAccessKey.description")
	case "s3.prefix":
		return storageVisible("input", "/photos", "s3", false, "settings.storage.s3.prefix.description")
	case "s3.cdnUrl":
		return storageVisible("input", "", "s3", false, "settings.storage.s3.cdnUrl.description")
	case "s3.forcePathStyle":
		return storageVisible("toggle", "", "s3", false, "settings.storage.s3.forcePathStyle.description")
	case "s3.maxKeys":
		return storageVisible("number", "", "s3", false, "settings.storage.s3.maxKeys.description")
	case "openlist.baseUrl":
		return storageVisible("input", "https://alist.example.com", openlist, true, "settings.storage.openlist.baseUrl.description")
	case "openlist.rootPath":
		return storageVisible("input", "/photos", openlist, true, "settings.storage.openlist.rootPath.description")
	case "openlist.token":
		return storageVisible("password", "", openlist, true, "settings.storage.openlist.token.description")
	case "openlist.cdnUrl":
		return storageVisible("input", "", openlist, false, "settings.storage.openlist.cdnUrl.description")
	case "openlist.uploadEndpoint":
		return storageVisible("input", "/api/fs/put", openlist, false, "settings.storage.openlist.uploadEndpoint.description")
	case "openlist.downloadEndpoint":
		return storageVisible("input", "", openlist, false, "settings.storage.openlist.downloadEndpoint.description")
	case "openlist.listEndpoint":
		return storageVisible("input", "", openlist, false, "settings.storage.openlist.listEndpoint.description")
	case "openlist.deleteEndpoint":
		return storageVisible("input", "/api/fs/remove", openlist, false, "settings.storage.openlist.deleteEndpoint.description")
	case "openlist.metaEndpoint":
		return storageVisible("input", "/api/fs/get", openlist, false, "settings.storage.openlist.metaEndpoint.description")
	case "openlist.pathField":
		return storageVisible("input", "path", openlist, false, "settings.storage.openlist.pathField.description")
	}
	return nil
}

func storageVisible(kind, placeholder, provider string, required bool, help string) map[string]any {
	config := map[string]any{
		"type":      kind,
		"visibleIf": map[string]any{"fieldKey": "provider", "value": provider},
	}
	if placeholder != "" {
		config["placeholder"] = placeholder
	}
	if required {
		config["required"] = true
	}
	if help != "" {
		config["help"] = help
	}
	return config
}
