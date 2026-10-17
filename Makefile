test:
	node --test overlay-manager/test/*.test.js testfeed/test/*.test.js

camconfig:
	node testfeed/camconfig.js

feed:
	cd testfeed && ./start.sh

manager:
	cd overlay-manager && ./start.sh

lyrics:
	cd wirecast_songs && node ./generate-song-presets.js
