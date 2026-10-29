-- Keyset pages for the asset hub list (ORDER BY createdAt DESC, id DESC).
-- Props are rows in global_locations (assetKind = 'prop'), so they share that index.
-- custom_art_styles already has (userId, createdAt).

CREATE INDEX `global_characters_userId_folderId_createdAt_idx` ON `global_characters`(`userId`, `folderId`, `createdAt`);

CREATE INDEX `global_locations_userId_folderId_createdAt_idx` ON `global_locations`(`userId`, `folderId`, `createdAt`);

CREATE INDEX `global_voices_userId_folderId_createdAt_idx` ON `global_voices`(`userId`, `folderId`, `createdAt`);
