const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const mongoose = require('mongoose');

// 1. Kết nối MongoDB sử dụng biến môi trường từ Docker
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/user_db';
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ User Service connected to MongoDB (user_db)'))
    .catch(err => console.error('MongoDB connection error:', err));

// 2. Định nghĩa Schema cho User
const userSchema = new mongoose.Schema({
    name: String,
    email: String
});
// Định dạng lại _id của Mongo thành id (string) để khớp với file .proto
userSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
    }
});
const User = mongoose.model('User', userSchema);

// Load Proto
const packageDef = protoLoader.loadSync(path.join(__dirname, '../proto/user.proto'));
const userProto = grpc.loadPackageDefinition(packageDef).user;

// 3. Cập nhật Logic RPC sang dạng Async/Await để gọi DB
async function CreateUser(call, callback) {
    try {
        const newUser = new User({
            name: call.request.name,
            email: call.request.email
        });
        const savedUser = await newUser.save();
        console.log(`[User] Created in DB: ${savedUser.name}`);

        callback(null, savedUser.toJSON());
    } catch (error) {
        callback({ code: grpc.status.INTERNAL, details: error.message });
    }
}

async function GetUser(call, callback) {
    try {
        // Chú ý: trong file .proto id là string, MongoDB dùng ObjectId, Mongoose sẽ tự convert giúp ta
        const user = await User.findById(call.request.id);
        if (!user) {
            return callback({ code: grpc.status.NOT_FOUND, details: "User Not Found" });
        }
        callback(null, user.toJSON());
    } catch (error) {
        callback({ code: grpc.status.INTERNAL, details: error.message });
    }
}

// Khởi động Server gRPC
const server = new grpc.Server();
server.addService(userProto.UserService.service, { CreateUser, GetUser });
server.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), () => {
    console.log('User Service running on port 50051');
});