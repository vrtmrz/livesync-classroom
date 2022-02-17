# Docker Instructions

1. Clone the Github Repository
```git
git clone https://github.com/vrtmrz/livesync-classroom.git
```
2. Open the config file dat/config.sample.json, edit and save to dat/config.json
3. Build the Dockerfile
```bash
sudo docker build -t obsidian-livesync-classroom .
```
4. Create the docker container
```bash
sudo docker-compose up -d
```
