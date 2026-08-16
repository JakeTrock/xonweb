// Xonotic WASM - On-Demand Asset Streaming Pre.js
// 
// Strategy:
// 1. Download only essential files upfront (gamecode, configs, fonts)
// 2. Hook into Emscripten's filesystem to fetch missing files on demand
// 3. Cache fetched files in IDBFS for persistence

// The engine needs -game xonotic-data.pk3dir to find gamecode and configs
if (!Object.hasOwn(Module, 'arguments')) {
	Module['arguments'] = ['-basedir', '/game', '-game', 'xonotic-data.pk3dir'];
}
else {
	Module['arguments'] = ['-basedir', '/game', '-game', 'xonotic-data.pk3dir'].concat(Module['arguments']);
}

Module['print'] = function(text) {
	console.log(text);
};

Module['printErr'] = function(text) {
	console.error(text);
};

// --- Asset Server Configuration ---
Module['assetBaseUrl'] = Module['assetBaseUrl'] || '/game/';

// --- Essential files that must be downloaded before the engine starts ---
// These go into /game/ which is the basedir. The engine will look for them
// in the gamedir (xonotic-data.pk3dir) subdirectory.
Module['essentialFiles'] = Module['essentialFiles'] || [
	// Gamecode - must be in the gamedir
	'xonotic-data.pk3dir/progs.dat',
	'xonotic-data.pk3dir/csprogs.dat',
	'xonotic-data.pk3dir/menu.dat',
	// Configs - in the gamedir
	'xonotic-data.pk3dir/default.cfg',
	'xonotic-data.pk3dir/xonotic-common.cfg',
	'xonotic-data.pk3dir/xonotic-client.cfg',
	'xonotic-data.pk3dir/xonotic-server.cfg',
	'xonotic-data.pk3dir/balance-xonotic.cfg',
	'xonotic-data.pk3dir/binds-xonotic.cfg',
	'xonotic-data.pk3dir/_hud_common.cfg',
	'xonotic-data.pk3dir/_hud_descriptions.cfg',
	'xonotic-data.pk3dir/autoexec.cfg',
	// Map
	'xonotic-data.pk3dir/maps/_init/_init.bsp',
	// Font config
	'font-xolonium.pk3dir/font-xolonium.cfg',
	'font-xolonium.pk3dir/fonts/xolonium-regular.otf',
	'font-xolonium.pk3dir/fonts/xolonium-bold.otf',
];

// --- Track downloaded files to avoid re-fetching ---
Module._downloadedFiles = new Set();
Module._pendingFetches = new Map();
Module._totalDownloaded = 0;
Module._fileCount = 0;

// --- Progress callback ---
Module['onDownloadProgress'] = Module['onDownloadProgress'] || function(file, total, count) {
	console.log('Downloaded ' + count + ' files, ' + total + ' bytes total. Last: ' + file);
};

// --- Fetch a single file from the asset server ---
Module._fetchFile = function(localPath) {
	if (Module._downloadedFiles.has(localPath)) {
		return Promise.resolve();
	}
	
	if (Module._pendingFetches.has(localPath)) {
		return Module._pendingFetches.get(localPath);
	}
	
	var remoteUrl = Module['assetBaseUrl'] + localPath;
	var promise = fetch(remoteUrl)
		.then(function(response) {
			if (!response.ok) {
				throw new Error('HTTP ' + response.status + ' for ' + localPath);
			}
			return response.arrayBuffer();
		})
		.then(function(arrayBuffer) {
			var buffer = new Uint8Array(arrayBuffer);
			
			// Create parent directories
			var parts = localPath.split('/');
			for (var i = 1; i < parts.length; i++) {
				var dir = '/game/' + parts.slice(0, i).join('/');
				try {
					FS.mkdir(dir);
				} catch (e) { /* already exists */ }
			}
			
			// Write file to MEMFS
			var stream = FS.open('/game/' + localPath, 'w');
			FS.write(stream, buffer, 0, buffer.byteLength);
			FS.close(stream);
			
			Module._downloadedFiles.add(localPath);
			Module._totalDownloaded += buffer.byteLength;
			Module._fileCount++;
			Module['onDownloadProgress'](localPath, Module._totalDownloaded, Module._fileCount);
			
			Module._pendingFetches.delete(localPath);
		})
		.catch(function(err) {
			console.warn('Failed to fetch ' + localPath + ': ' + err.message);
			Module._pendingFetches.delete(localPath);
			Module._downloadedFiles.add(localPath);
		});
	
	Module._pendingFetches.set(localPath, promise);
	return promise;
};

// --- Pre-fetch files associated with a map ---
Module['prefetchMap'] = function(mapName) {
	var patterns = [
		'xonotic-data.pk3dir/maps/' + mapName + '.bsp',
		'xonotic-data.pk3dir/maps/' + mapName + '.mapinfo',
		'xonotic-data.pk3dir/maps/' + mapName + '.waypoints',
	];
	patterns.forEach(function(p) {
		Module._fetchFile(p);
	});
};

Module['preRun'] = [
	function() {
		function stdin() {
			return '\n';
		}
		FS.init(stdin, null, null);
		
		// Create base directory and mount IDBFS for persistence
		FS.mkdir('/game');
		FS.mount(IDBFS, {}, '/home/web_user/');
		
		console.log('Downloading essential game files...');
		
		var downloads = Module['essentialFiles'].map(function(f) {
			return Module._fetchFile(f);
		});
		
		Promise.all(downloads)
			.then(function() {
				console.log('All essential files downloaded. Starting engine...');
				FS.syncfs(true, function(err) {
					if (err) console.warn('IDBFS sync error:', err);
					Module.callMain(Module.arguments);
				});
			})
			.catch(function(err) {
				console.error('Failed to download essential files:', err);
				Module.callMain(Module.arguments);
			});
	}
];

Module['noInitialRun'] = true;
