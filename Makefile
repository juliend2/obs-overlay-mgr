test:
	node --test overlay-manager/test/

feed:
	cd testfeed && ./start.sh

manager:
	cd overlay-manager && ./start.sh
