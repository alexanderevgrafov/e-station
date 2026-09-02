#!/bin/bash

cd /home/dietpi/e-station
echo "**** Restart *****"
sudo systemctl restart e-station-server.service

echo "**** Make ****"
cd ./epd_util
make
cd ..

echo "**** Waiting for server ****"
for i in $(seq 1 15); do
  curl -s -o /dev/null http://localhost:3333/api/clock && break
  sleep 1
done

echo "**** Full clear ****"
curl -s http://localhost:3333/api/clear-full
echo

echo "**** Start clock ****"
curl -s "http://localhost:3333/api/clock?start=1"
echo