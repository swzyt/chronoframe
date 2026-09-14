UPDATE `settings`
SET
  `value` = CASE
    WHEN `value` IS NULL
      OR `value` = ''
      OR `value` IN ('en', 'zh', 'zh-CN')
    THEN 'zh-Hans'
    WHEN `value` = 'zh-TW'
    THEN 'zh-Hant-TW'
    WHEN `value` = 'zh-HK'
    THEN 'zh-Hant-HK'
    ELSE `value`
  END,
  `default_value` = 'zh-Hans',
  `enum` = '["zh-Hans","zh-Hant-TW","zh-Hant-HK","en","ja","ru"]'
WHERE `namespace` = 'location' AND `key` = 'language';
