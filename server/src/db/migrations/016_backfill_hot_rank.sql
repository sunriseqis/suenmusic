-- 回填存量推荐库的 hot_rank。
--
-- 存量数据是早期按 `getArtistSongs` 的顺序写入的（saveLibraryTracks 先删后插、
-- 按接口返回顺序插），所以**同一歌手下 rowid 的相对顺序 == 热度顺序**。
-- 幂等：只填 hot_rank = 0 的行。
UPDATE library_tracks
   SET hot_rank = (
     SELECT COUNT(*) FROM library_tracks l2
      WHERE l2.artist_mid = library_tracks.artist_mid
        AND l2.rowid <= library_tracks.rowid
   )
 WHERE hot_rank = 0;
