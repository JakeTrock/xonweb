// Prefetch map shaders + textures into MEMFS (IDBFS-backed) before connect.
// Placeholder (notexture checkerboard) is only used if a file cannot be fetched.
(function (global) {
	'use strict';

	var GAMEDIRS = ['xonotic-maps.pk3dir', 'xonotic-data.pk3dir'];
	var IMAGE_EXTS = ['.tga', '.jpg', '.jpeg', '.png'];
	var SKIP_MAPS = {
		'$lightmap': 1, '$whiteimage': 1, '$identitynormalmap': 1,
		'*white': 1, '*black': 1, '*grey': 1, '*gray': 1, '-': 1
	};
	var CONCURRENCY = 8;

	function fsObj() {
		return (global.FS) || (global.Module && global.Module.FS) || null;
	}

	function fileExists(p) {
		var FS = fsObj();
		if (!FS) return false;
		try {
			var st = FS.stat(p);
			return st && st.size > 0;
		} catch (e) {
			return false;
		}
	}

	function ensureDir(p) {
		var FS = fsObj();
		if (!FS) return;
		var parts = p.split('/');
		var acc = '';
		for (var i = 0; i < parts.length; i++) {
			if (!parts[i]) continue;
			acc += '/' + parts[i];
			try { FS.mkdir(acc); } catch (e) { /* exists */ }
		}
	}

	function readFile(p) {
		var FS = fsObj();
		if (!FS || !fileExists(p)) return null;
		try {
			return FS.readFile(p);
		} catch (e) {
			return null;
		}
	}

	function writeFile(p, data) {
		var FS = fsObj();
		if (!FS) throw new Error('FS not ready');
		var slash = p.lastIndexOf('/');
		if (slash > 0) ensureDir(p.substring(0, slash));
		var stream = FS.open(p, 'w');
		FS.write(stream, data, 0, data.byteLength);
		FS.close(stream);
		if (global.Module && global.Module._downloadedFiles && typeof global.Module._downloadedFiles.add === 'function') {
			var rel = p.indexOf('/game/') === 0 ? p.substring('/game/'.length) : p;
			global.Module._downloadedFiles.add(rel);
		}
	}

	function persistIdbfs() {
		var FS = fsObj();
		if (!FS || typeof FS.syncfs !== 'function') return Promise.resolve();
		// Don't block connect on IndexedDB. A large texture write against a
		// warm 2.8GB IDBFS can take minutes; MEMFS already has the files.
		try {
			FS.syncfs(false, function (err) {
				if (err) console.warn('[map-assets] IDBFS sync failed:', err);
				else console.log('[map-assets] persisted to IDBFS');
			});
		} catch (e) {
			console.warn('[map-assets] IDBFS sync throw:', e);
		}
		return Promise.resolve();
	}

	function pool(items, limit, fn) {
		if (!items.length) return Promise.resolve([]);
		var i = 0;
		var active = 0;
		var results = new Array(items.length);
		return new Promise(function (resolve) {
			function next() {
				if (i >= items.length && active === 0) {
					resolve(results);
					return;
				}
				while (active < limit && i < items.length) {
					(function (idx) {
						active++;
						Promise.resolve(fn(items[idx], idx)).then(function (r) {
							results[idx] = r;
							active--;
							next();
						}, function (err) {
							results[idx] = { error: String(err && err.message ? err.message : err) };
							active--;
							next();
						});
					})(i++);
				}
			}
			next();
		});
	}

	function u32(b, o) {
		return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
	}
	function u16(b, o) {
		return b[o] | (b[o + 1] << 8);
	}

	function findEocd(bytes) {
		var min = Math.max(0, bytes.length - 22 - 65535);
		for (var i = bytes.length - 22; i >= min; i--) {
			if (u32(bytes, i) === 0x06054b50) return i;
		}
		return -1;
	}

	function inflateRaw(bytes) {
		if (typeof DecompressionStream === 'undefined') {
			return Promise.reject(new Error('DecompressionStream unavailable'));
		}
		return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')))
			.arrayBuffer()
			.then(function (ab) { return new Uint8Array(ab); });
	}

	function zipExtract(bytes, innerPath) {
		innerPath = innerPath.replace(/^\/+/, '');
		var eocd = findEocd(bytes);
		if (eocd < 0) return Promise.resolve(null);
		var cdOff = u32(bytes, eocd + 16);
		var cdSize = u32(bytes, eocd + 12);
		var cdEnd = Math.min(bytes.length, cdOff + cdSize);
		var p = cdOff;
		while (p + 46 <= cdEnd) {
			if (u32(bytes, p) !== 0x02014b50) break;
			var method = u16(bytes, p + 10);
			var compSize = u32(bytes, p + 20);
			var nameLen = u16(bytes, p + 28);
			var extraLen = u16(bytes, p + 30);
			var commentLen = u16(bytes, p + 32);
			var localOff = u32(bytes, p + 42);
			var name = '';
			for (var i = 0; i < nameLen; i++) name += String.fromCharCode(bytes[p + 46 + i]);
			if (name === innerPath || name.replace(/\\/g, '/') === innerPath) {
				var lh = localOff;
				if (u32(bytes, lh) !== 0x04034b50) return Promise.resolve(null);
				var lName = u16(bytes, lh + 26);
				var lExtra = u16(bytes, lh + 28);
				var dataOff = lh + 30 + lName + lExtra;
				var slice = bytes.subarray(dataOff, dataOff + compSize);
				if (method === 0) return Promise.resolve(slice);
				if (method === 8) return inflateRaw(slice);
				return Promise.reject(new Error('zip method ' + method + ' unsupported'));
			}
			p += 46 + nameLen + extraLen + commentLen;
		}
		return Promise.resolve(null);
	}

	function parseBspTextures(bsp) {
		if (!bsp || bsp.length < 16) return [];
		var ident = String.fromCharCode(bsp[0], bsp[1], bsp[2], bsp[3]);
		var ver = u32(bsp, 4);
		if (ident !== 'IBSP') {
			console.warn('[map-assets] unknown BSP ident ' + ident);
			return [];
		}
		// Q3 / Q3-derived (Xonotic): lump 1 is TEXTURES, 72 bytes each
		if (ver !== 46 && ver !== 47) {
			console.warn('[map-assets] BSP version ' + ver + ' — trying Q3 texture lump anyway');
		}
		var off = u32(bsp, 8 + 1 * 8);
		var len = u32(bsp, 8 + 1 * 8 + 4);
		if (off + len > bsp.length || len <= 0) return [];
		var stride = 72;
		var n = Math.floor(len / stride);
		var names = [];
		var seen = {};
		for (var i = 0; i < n; i++) {
			var base = off + i * stride;
			var chars = [];
			for (var c = 0; c < 64; c++) {
				var b = bsp[base + c];
				if (!b) break;
				chars.push(b);
			}
			var name = String.fromCharCode.apply(null, chars).replace(/\0+$/, '');
			if (!name || name === 'noshader' || seen[name]) continue;
			seen[name] = 1;
			names.push(name);
		}
		return names;
	}

	function readdirSafe(dir) {
		var FS = fsObj();
		if (!FS) return [];
		try {
			return FS.readdir(dir) || [];
		} catch (e) {
			return [];
		}
	}

	function findPk3Paths(mapName) {
		var needle = String(mapName || '').toLowerCase();
		var out = [];
		for (var d = 0; d < GAMEDIRS.length; d++) {
			var dir = '/game/' + GAMEDIRS[d];
			var names = readdirSafe(dir);
			for (var i = 0; i < names.length; i++) {
				var fn = names[i];
				if (!/\.pk3$/i.test(fn)) continue;
				if (needle && fn.toLowerCase().indexOf(needle) === -1) continue;
				out.push(dir + '/' + fn);
			}
		}
		return out;
	}

	function findBsp(mapName) {
		var loose = [
			'/game/xonotic-maps.pk3dir/maps/' + mapName + '.bsp',
			'/game/xonotic-data.pk3dir/maps/' + mapName + '.bsp',
		];
		for (var i = 0; i < loose.length; i++) {
			var data = readFile(loose[i]);
			if (data) return Promise.resolve(data);
		}
		var pk3s = findPk3Paths(mapName);
		// If the map name is not in any pk3 filename, scan every pack (cts_*.pk3).
		if (!pk3s.length) pk3s = findPk3Paths('');
		function tryNext(idx) {
			if (idx >= pk3s.length) return Promise.resolve(null);
			var bytes = readFile(pk3s[idx]);
			if (!bytes) return tryNext(idx + 1);
			return zipExtract(bytes, 'maps/' + mapName + '.bsp').then(function (bsp) {
				if (bsp && bsp.length) {
					console.log('[map-assets] BSP maps/' + mapName + '.bsp from ' + pk3s[idx]);
					return bsp;
				}
				return tryNext(idx + 1);
			}).catch(function (err) {
				console.warn('[map-assets] unzip ' + pk3s[idx] + ': ' + err.message);
				return tryNext(idx + 1);
			});
		}
		return tryNext(0);
	}

	function dirlist(prefix) {
		var url = '/dirlist?prefix=' + encodeURIComponent(prefix || '');
		return fetch(url).then(function (res) {
			if (!res.ok) throw new Error('dirlist HTTP ' + res.status);
			return res.json();
		}).then(function (j) {
			return (j && j.files) ? j.files : [];
		}).catch(function (err) {
			console.warn('[map-assets] dirlist ' + prefix + ': ' + err.message);
			return [];
		});
	}

	function fetchToMemfs(relPath) {
		var dest = '/game/' + relPath;
		if (fileExists(dest)) return Promise.resolve({ path: relPath, skipped: true });
		return fetch('/game/' + relPath).then(function (res) {
			if (!res.ok) return { path: relPath, missing: true, status: res.status };
			return res.arrayBuffer().then(function (ab) {
				writeFile(dest, new Uint8Array(ab));
				return { path: relPath, bytes: ab.byteLength };
			});
		}).catch(function (err) {
			return { path: relPath, missing: true, error: err.message };
		});
	}

	function splitShaderBlocks(text) {
		var blocks = {};
		var lines = String(text).split(/\r?\n/);
		var name = null;
		var depth = 0;
		var body = [];
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i].replace(/\/\/.*$/, '').trim();
			if (!line) continue;
			if (depth === 0) {
				if (line === '{') {
					depth = 1;
					continue;
				}
				name = line.split(/\s+/)[0];
				body = [];
				continue;
			}
			var opens = (line.match(/{/g) || []).length;
			var closes = (line.match(/}/g) || []).length;
			body.push(line);
			depth += opens - closes;
			if (depth <= 0) {
				if (name) blocks[name] = body.join('\n');
				name = null;
				depth = 0;
			}
		}
		return blocks;
	}

	function isTexturePath(p) {
		if (!p || SKIP_MAPS[p.toLowerCase()]) return false;
		if (p.charAt(0) === '$' || p.charAt(0) === '*') return false;
		return p.indexOf('/') !== -1 || /\.(tga|jpg|jpeg|png|pcx)$/i.test(p);
	}

	function extractShaderRefs(body) {
		var maps = [];
		var skies = [];
		var tokens = String(body).split(/\s+/);
		for (var i = 0; i < tokens.length; i++) {
			var t = tokens[i].toLowerCase();
			if (t === 'map' || t === 'clampmap' || t === 'qer_editorimage') {
				var p = tokens[i + 1];
				if (isTexturePath(p)) maps.push(p.replace(/^"|"$/g, ''));
			} else if (t === 'animmap') {
				i++; // skip rate
				while (tokens[i + 1] && isTexturePath(tokens[i + 1])) {
					maps.push(tokens[++i].replace(/^"|"$/g, ''));
				}
			} else if (t === 'skyparms') {
				var sky = tokens[i + 1];
				if (sky && sky !== '-') skies.push(sky.replace(/^"|"$/g, ''));
			}
		}
		return { maps: maps, skies: skies };
	}

	function stripExt(p) {
		return p.replace(/\.(tga|jpg|jpeg|png|pcx)$/i, '');
	}

	function shaderFileGuesses(shaderName) {
		var parts = shaderName.split('/');
		var out = [];
		if (parts.length >= 2) {
			out.push('scripts/' + parts[1] + '.shader');
			if (parts.length >= 3) {
				out.push('scripts/' + parts[1] + '_' + parts[2] + '.shader');
			}
		}
		return out;
	}

	function unique(arr) {
		var seen = {};
		var out = [];
		for (var i = 0; i < arr.length; i++) {
			if (!arr[i] || seen[arr[i]]) continue;
			seen[arr[i]] = 1;
			out.push(arr[i]);
		}
		return out;
	}

	function imageRelCandidates(imagePath) {
		var p = imagePath.replace(/^\/+/, '');
		var out = [];
		if (/\.(tga|jpg|jpeg|png|pcx)$/i.test(p)) {
			out.push(p);
		} else {
			for (var i = 0; i < IMAGE_EXTS.length; i++) out.push(p + IMAGE_EXTS[i]);
		}
		return out;
	}

	function gamedirRels(rel) {
		var out = [];
		for (var i = 0; i < GAMEDIRS.length; i++) out.push(GAMEDIRS[i] + '/' + rel);
		return out;
	}

	function fetchFirstHit(relPaths) {
		function next(i) {
			if (i >= relPaths.length) return Promise.resolve(null);
			return fetchToMemfs(relPaths[i]).then(function (r) {
				if (r && !r.missing) return r;
				return next(i + 1);
			});
		}
		return next(0);
	}

	function companionPrefix(imagePath) {
		var p = stripExt(imagePath.replace(/^\/+/, ''));
		var slash = p.lastIndexOf('/');
		return {
			dir: slash >= 0 ? p.substring(0, slash) : '',
			stem: slash >= 0 ? p.substring(slash + 1) : p
		};
	}

	function prefetch(mapName, onProgress) {
		var progress = onProgress || function () {};
		var stats = { shaders: 0, images: 0, skipped: 0, missing: 0, bsp: null };

		function report(status, percent) {
			progress({ status: status, percent: percent || 0, stats: stats });
		}

		if (!mapName || mapName === 'unknown') {
			return Promise.resolve(stats);
		}

		report('Reading map ' + mapName + '…', 2);

		return findBsp(mapName).then(function (bsp) {
			if (!bsp) {
				console.warn('[map-assets] no BSP for ' + mapName + ' — cannot prefetch textures');
				stats.bsp = false;
				return stats;
			}
			stats.bsp = true;
			var shaderNames = parseBspTextures(bsp);
			console.log('[map-assets] ' + mapName + ' references ' + shaderNames.length + ' shaders');
			report('Fetching shader scripts…', 8);

			return dirlist('xonotic-maps.pk3dir/scripts').then(function (scriptFiles) {
				var shaderRels = [];
				var wantedGuesses = {};
				for (var s = 0; s < shaderNames.length; s++) {
					var guesses = shaderFileGuesses(shaderNames[s]);
					for (var g = 0; g < guesses.length; g++) wantedGuesses[guesses[g]] = 1;
				}
				var neededShader = {};
				for (var k in wantedGuesses) neededShader['xonotic-maps.pk3dir/' + k] = 1;
				for (var i = 0; i < scriptFiles.length; i++) {
					var p = scriptFiles[i].path;
					if (!/\.shader$/i.test(p)) continue;
					var base = p.split('/').pop();
					var stem = base.replace(/\.shader$/i, '');
					var keep = false;
					for (var s = 0; s < shaderNames.length; s++) {
						var parts = shaderNames[s].split('/');
						if (parts[1] && (stem === parts[1] || stem.indexOf(parts[1] + '_') === 0 || stem.indexOf(parts[1]) === 0)) {
							keep = true;
							break;
						}
						if (parts[2] && stem.indexOf(parts[2]) !== -1) { keep = true; break; }
					}
					if (keep) shaderRels.push(p);
				}
				if (!shaderRels.length) {
					for (var kg in neededShader) shaderRels.push(kg);
				}
				shaderRels = unique(shaderRels);

				return pool(shaderRels, CONCURRENCY, function (rel) {
					return fetchToMemfs(rel);
				}).then(function (shaderResults) {
					var imagePaths = [];
					var skyBases = [];
					var wanted = {};
					for (var i = 0; i < shaderNames.length; i++) wanted[shaderNames[i]] = 1;
					// Direct image names (no shader) still need a file fetch
					for (var n = 0; n < shaderNames.length; n++) {
						if (shaderNames[n].indexOf('textures/') === 0) imagePaths.push(shaderNames[n]);
					}
					for (var r = 0; r < shaderResults.length; r++) {
						var sr = shaderResults[r];
						if (!sr || sr.missing || sr.error) continue;
						if (!sr.skipped) stats.shaders++;
						else stats.skipped++;
						var textBytes = readFile('/game/' + sr.path);
						if (!textBytes) continue;
						var text = new TextDecoder('latin1').decode(textBytes);
						var blocks = splitShaderBlocks(text);
						for (var name in blocks) {
							if (!wanted[name] && !wanted[name.toLowerCase()]) continue;
							var refs = extractShaderRefs(blocks[name]);
							for (var m = 0; m < refs.maps.length; m++) imagePaths.push(refs.maps[m]);
							for (var sk = 0; sk < refs.skies.length; sk++) skyBases.push(refs.skies[sk]);
						}
					}
					imagePaths = unique(imagePaths);
					skyBases = unique(skyBases);
					console.log('[map-assets] ' + imagePaths.length + ' image paths, ' + skyBases.length + ' skies');
					report('Downloading textures (0/' + imagePaths.length + ')…', 20);

					var toFetch = [];
					var seenFetch = {};
					function queueRel(rel) {
						if (!rel || seenFetch[rel]) return;
						seenFetch[rel] = 1;
						toFetch.push(rel);
					}

					var companionJobs = [];
					for (var ip2 = 0; ip2 < imagePaths.length; ip2++) {
						var loc = companionPrefix(imagePaths[ip2]);
						if (!loc.dir) continue;
						companionJobs.push(loc);
					}
					for (var sb = 0; sb < skyBases.length; sb++) {
						var skyDir = skyBases[sb].replace(/\/[^/]+$/, '');
						companionJobs.push({ dir: skyDir, stem: '', sky: true, base: skyBases[sb] });
					}

					function addDirMatches() {
						return pool(unique(companionJobs.map(function (j) { return j.dir; })), 4, function (dir) {
							return Promise.all([
								dirlist('xonotic-maps.pk3dir/' + dir),
								dirlist('xonotic-data.pk3dir/' + dir)
							]).then(function (lists) {
								return { dir: dir, files: (lists[0] || []).concat(lists[1] || []) };
							});
						}).then(function (listings) {
							var byDir = {};
							for (var i = 0; i < listings.length; i++) {
								if (!listings[i] || !listings[i].dir) continue;
								byDir[listings[i].dir] = listings[i].files || [];
							}
							for (var j = 0; j < companionJobs.length; j++) {
								var job = companionJobs[j];
								var files = byDir[job.dir] || [];
								for (var f = 0; f < files.length; f++) {
									var fp = files[f].path || '';
									var base = fp.split('/').pop() || '';
									if (/\.(xcf|sh|txt|md)$/i.test(base)) continue;
									if (job.sky) {
										var skyStem = job.base.split('/').pop();
										if (base.indexOf(skyStem) !== 0) continue;
									} else if (job.stem) {
										if (base !== job.stem && base.indexOf(job.stem + '.') !== 0 && base.indexOf(job.stem + '_') !== 0) continue;
									}
									if (fp.indexOf('xonotic-maps.pk3dir/') === 0 || fp.indexOf('xonotic-data.pk3dir/') === 0) {
										queueRel(fp);
									} else {
										queueRel('xonotic-maps.pk3dir/' + fp);
									}
								}
							}
						});
					}

					return addDirMatches().then(function () {
						return pool(imagePaths, CONCURRENCY, function (img) {
							var loc = companionPrefix(img);
							for (var t = 0; t < toFetch.length; t++) {
								if (loc.stem && toFetch[t].indexOf(loc.stem) !== -1) return null;
							}
							var rels = [];
							var cands = imageRelCandidates(img);
							for (var i = 0; i < cands.length; i++) {
								var gd = gamedirRels(cands[i]);
								for (var j = 0; j < gd.length; j++) rels.push(gd[j]);
							}
							return fetchFirstHit(rels);
						});
					}).then(function () {
						toFetch = unique(toFetch);
						var done = 0;
						var total = toFetch.length || 1;
						report('Downloading textures (0/' + toFetch.length + ')…', 25);
						return pool(toFetch, CONCURRENCY, function (rel) {
							return fetchToMemfs(rel).then(function (r) {
								done++;
								if (r && r.skipped) stats.skipped++;
								else if (r && r.missing) stats.missing++;
								else if (r && r.bytes) stats.images++;
								if (done === toFetch.length || done % 4 === 0) {
									report('Downloading textures (' + done + '/' + toFetch.length + ')…', 25 + Math.floor(70 * done / total));
								}
								return r;
							});
						});
					}).then(function () {
						report('Saving texture cache…', 97);
						return persistIdbfs();
					}).then(function () {
						console.log('[map-assets] done', stats);
						report('Textures ready', 100);
						return stats;
					});
				});
			});
		});
	}

	global.xonMapAssets = {
		prefetch: prefetch,
		findBsp: findBsp,
		parseBspTextures: parseBspTextures,
	};
})(typeof window !== 'undefined' ? window : this);
