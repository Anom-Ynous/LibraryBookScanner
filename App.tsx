import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Modal,
  Alert,
  FlatList,
  TextInput,
  Platform,
} from 'react-native';
import NfcManager, { NfcTech } from 'react-native-nfc-manager';
import firestore from '@react-native-firebase/firestore';
import {
  Camera,
  useCameraDevice,
  useCodeScanner,
} from 'react-native-vision-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ===================== TYPES =====================
type BookStatus = 'available' | 'checked out' | 'not available' | 'missing';

interface Book {
  uid: string;
  barcode: string;
  title: string;
  author: string;
  isbn: string;
  callNumber: string;
  location: string;
}

interface StatusData {
  status: BookStatus;
  holder: string;
  dueDate: string | null;
  extended: boolean;
  borrowedAt: string | null;
}

type Screen =
  | 'login'
  | 'home'
  | 'scan'
  | 'bookActions'
  | 'bookInfo'
  | 'afterAction'
  | 'myBooks'
  | 'adminEdit';

// ===================== MAIN COMPONENT =====================
export default function LibraryApp() {
  // Auth
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  // App state
  const [screen, setScreen] = useState<Screen>('login');
  const [scanning, setScanning] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [book, setBook] = useState<Book | null>(null);
  const [statusData, setStatusData] = useState<StatusData | null>(null);
  const [uid, setUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [cameraMode, setCameraMode] = useState<'auth' | 'book'>('auth');

  // My books
  const [myBorrowedBooks, setMyBorrowedBooks] = useState<
    { book: Book; status: StatusData }[]
  >([]);
  const [loadingMyBooks, setLoadingMyBooks] = useState(false);

  // Admin search
  const [adminSearch, setAdminSearch] = useState('');
  const [adminBook, setAdminBook] = useState<Book | null>(null);
  const [adminStatus, setAdminStatus] = useState<StatusData | null>(null);

  // Local fallback cache
  const [localBooks, setLocalBooks] = useState<Book[]>([]);
  const [localStatus, setLocalStatus] = useState<Record<string, StatusData>>({});

  const device = useCameraDevice('back');

  // ===================== INIT =====================
  useEffect(() => {
    NfcManager.start();
    loadLocalCache();
    return () => {
      NfcManager.cancelTechnologyRequest().catch(() => {});
    };
  }, []);

  const loadLocalCache = async () => {
    try {
      const books = await AsyncStorage.getItem('local_books');
      const status = await AsyncStorage.getItem('local_status');
      if (books) setLocalBooks(JSON.parse(books));
      if (status) setLocalStatus(JSON.parse(status));
    } catch (e) {
      console.warn('Failed to load local cache', e);
    }
  };

  const saveLocalCache = async (books: Book[], status: Record<string, StatusData>) => {
    try {
      await AsyncStorage.setItem('local_books', JSON.stringify(books));
      await AsyncStorage.setItem('local_status', JSON.stringify(status));
    } catch (e) {
      console.warn('Failed to save local cache', e);
    }
  };

  // ===================== HELPERS =====================
  const addDays = (date: Date, days: number) => {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  const isOverdue = (dueDate: string | null) => {
    if (!dueDate) return false;
    return dueDate < new Date().toISOString().split('T')[0];
  };

  const safeFirestore = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      const result = await fn();
      setIsOnline(true);
      return result;
    } catch (e) {
      console.warn('Firebase error → offline mode', e);
      setIsOnline(false);
      return fallback;
    }
  };

  // ===================== FIRESTORE + LOCAL =====================
  const fetchBookByBarcode = async (barcode: string): Promise<Book | null> => {
    return safeFirestore(async () => {
      const doc = await firestore().collection('books').doc(barcode).get();
      if (doc.exists) {
        const data = doc.data() as Book;
        const updated = [...localBooks.filter(b => b.barcode !== barcode), data];
        setLocalBooks(updated);
        saveLocalCache(updated, localStatus);
        return data;
      }
      return null;
    }, localBooks.find(b => b.barcode === barcode) || null);
  };

  const fetchBookByUid = async (scannedUid: string): Promise<Book | null> => {
    return safeFirestore(async () => {
      const snap = await firestore()
        .collection('books')
        .where('uid', '==', scannedUid)
        .limit(1)
        .get();
      if (!snap.empty) {
        const data = snap.docs[0].data() as Book;
        const updated = [...localBooks.filter(b => b.barcode !== data.barcode), data];
        setLocalBooks(updated);
        saveLocalCache(updated, localStatus);
        return data;
      }
      return null;
    }, localBooks.find(b => b.uid === scannedUid) || null);
  };

  const fetchBookByIsbn = async (isbn: string): Promise<Book | null> => {
    return safeFirestore(async () => {
      const snap = await firestore()
        .collection('books')
        .where('isbn', '==', isbn)
        .limit(1)
        .get();
      return snap.empty ? null : (snap.docs[0].data() as Book);
    }, localBooks.find(b => b.isbn === isbn) || null);
  };

  const fetchStatus = async (barcode: string): Promise<StatusData> => {
    const defaultStatus: StatusData = {
      status: 'available',
      holder: 'library',
      dueDate: null,
      extended: false,
      borrowedAt: null,
    };

    return safeFirestore(async () => {
      const doc = await firestore().collection('book_status').doc(barcode).get();
      if (doc.exists) {
        const d = doc.data();
        const data: StatusData = {
          status: d?.status || 'available',
          holder: d?.holder || 'library',
          dueDate: d?.dueDate || null,
          extended: d?.extended || false,
          borrowedAt: d?.borrowedAt || null,
        };
        const updated = { ...localStatus, [barcode]: data };
        setLocalStatus(updated);
        saveLocalCache(localBooks, updated);
        return data;
      }
      return defaultStatus;
    }, localStatus[barcode] || defaultStatus);
  };

  const updateStatus = async (barcode: string, data: Partial<StatusData>) => {
    if (!isOnline) {
      Alert.alert('Offline', 'Cannot update status while offline');
      return false;
    }
    try {
      await firestore().collection('book_status').doc(barcode).set(data, { merge: true });
      const updated = {
        ...localStatus,
        [barcode]: { ...(localStatus[barcode] || {}), ...data } as StatusData,
      };
      setLocalStatus(updated);
      saveLocalCache(localBooks, updated);
      return true;
    } catch (e) {
      Alert.alert('Error', 'Failed to update status');
      return false;
    }
  };

  const loadMyBorrowedBooks = async (userBarcode: string) => {
    setLoadingMyBooks(true);
    try {
      const results: { book: Book; status: StatusData }[] = [];

      if (isOnline) {
        const snap = await firestore()
          .collection('book_status')
          .where('holder', '==', userBarcode)
          .get();

        for (const doc of snap.docs) {
          const st = doc.data() as StatusData;
          const b = await fetchBookByBarcode(doc.id);
          if (b) results.push({ book: b, status: st });
        }
      } else {
        Object.entries(localStatus).forEach(([barcode, st]) => {
          if (st.holder === userBarcode) {
            const b = localBooks.find(book => book.barcode === barcode);
            if (b) results.push({ book: b, status: st });
          }
        });
      }
      setMyBorrowedBooks(results);
    } catch (e) {
      console.warn(e);
    } finally {
      setLoadingMyBooks(false);
    }
  };

  // ===================== AUTH =====================
  const handleAuthBarcode = (code: string) => {
    setCurrentUser(code);
    setIsAdmin(code.startsWith('A'));
    setShowCamera(false);
    setScreen('home');
    loadMyBorrowedBooks(code);
  };

  // ===================== BOOK ACTIONS =====================
  const borrowBook = async () => {
    if (!book || !currentUser || !isOnline) return;
    const due = addDays(new Date(), 14);
    const success = await updateStatus(book.barcode, {
      status: 'checked out',
      holder: currentUser,
      dueDate: due,
      extended: false,
      borrowedAt: new Date().toISOString().split('T')[0],
    });
    if (success) {
      setStatusData({
        status: 'checked out',
        holder: currentUser,
        dueDate: due,
        extended: false,
        borrowedAt: new Date().toISOString().split('T')[0],
      });
      Alert.alert('Borrowed', `Due: ${due}`);
      setScreen('afterAction');
      loadMyBorrowedBooks(currentUser);
    }
  };

  const returnBook = async () => {
    if (!book || !isOnline) return;
    const success = await updateStatus(book.barcode, {
      status: 'available',
      holder: 'library',
      dueDate: null,
      extended: false,
      borrowedAt: null,
    });
    if (success) {
      setStatusData({
        status: 'available',
        holder: 'library',
        dueDate: null,
        extended: false,
        borrowedAt: null,
      });
      Alert.alert('Returned', 'Book is now available');
      setScreen('afterAction');
      if (currentUser) loadMyBorrowedBooks(currentUser);
    }
  };

  const extendBook = async () => {
    if (!book || !statusData || statusData.extended || !isOnline) return;
    const newDue = addDays(new Date(statusData.dueDate || new Date()), 14);
    const success = await updateStatus(book.barcode, {
      dueDate: newDue,
      extended: true,
    });
    if (success) {
      setStatusData({ ...statusData, dueDate: newDue, extended: true });
      Alert.alert('Extended', `New due date: ${newDue}`);
      setScreen('afterAction');
      if (currentUser) loadMyBorrowedBooks(currentUser);
    }
  };

  // ===================== SCANNING =====================
  const scanRFID = async () => {
    setScanning(true);
    setBook(null);
    setStatusData(null);
    setUid(null);
    setError(null);

    try {
      await NfcManager.requestTechnology(NfcTech.NfcV);
      const tag = await NfcManager.getTag();
      if (!tag?.id) throw new Error('No tag');

      const scannedUid = tag.id
        .map((b: number) => b.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();

      setUid(scannedUid);
      const matched = await fetchBookByUid(scannedUid);
      if (!matched) {
        setError('Book not found');
        return;
      }
      setBook(matched);
      const st = await fetchStatus(matched.barcode);
      setStatusData(st);
      setScreen('bookActions');
    } catch (e) {
      setError('RFID failed – try barcode');
    } finally {
      NfcManager.cancelTechnologyRequest().catch(() => {});
      setScanning(false);
    }
  };

  const codeScanner = useCodeScanner({
    codeTypes: ['code-128', 'code-39', 'codabar', 'ean-13', 'ean-8', 'qr'],
    onCodeScanned: (codes) => {
      if (!codes.length) return;
      const raw = codes[0].value?.trim().toUpperCase() || '';
      if (!/^[A-Z]\d{5}$/.test(raw) && cameraMode === 'auth') return;
      if (cameraMode === 'book' && !/^[A-Z]\d{5}$/.test(raw) && !/^\d{10,13}$/.test(raw)) return;

      setShowCamera(false);
      if (cameraMode === 'auth') {
        handleAuthBarcode(raw);
      } else {
        handleBookBarcode(raw);
      }
    },
  });

  const handleBookBarcode = async (code: string) => {
    setScanning(true);
    setError(null);
    let matched = await fetchBookByBarcode(code);
    if (!matched && /^\d{10,13}$/.test(code)) {
      matched = await fetchBookByIsbn(code);
    }
    if (!matched) {
      setError(`Not found: ${code}`);
      setScanning(false);
      return;
    }
    setBook(matched);
    const st = await fetchStatus(matched.barcode);
    setStatusData(st);
    setScanning(false);
    setScreen('bookActions');
  };

  // ===================== ADMIN =====================
  const adminFindBook = async () => {
    const text = adminSearch.trim().toUpperCase();
    if (!text) return;

    let found: Book | null = null;
    if (/^[A-Z]\d{5}$/.test(text)) {
      found = await fetchBookByBarcode(text);
    } else {
      found = await fetchBookByIsbn(text);
    }

    if (!found) {
      Alert.alert('Not found', 'No book matched');
      return;
    }
    setAdminBook(found);
    const st = await fetchStatus(found.barcode);
    setAdminStatus(st);
  };

  const adminSetStatus = async (newStatus: 'available' | 'not available' | 'missing') => {
    if (!adminBook || !isOnline) return;
    const data: Partial<StatusData> = { status: newStatus };
    if (newStatus === 'available') {
      data.holder = 'library';
      data.dueDate = null;
      data.extended = false;
      data.borrowedAt = null;
    }
    const success = await updateStatus(adminBook.barcode, data);
    if (success) {
      setAdminStatus({ ...(adminStatus as StatusData), ...data });
      Alert.alert('Updated', `Status → ${newStatus}`);
    }
  };

  // ===================== RENDER SCREENS =====================

  // LOGIN
  if (screen === 'login') {
    return (
      <View style={styles.container}>
        <Text style={styles.header}>Library System</Text>
        <Text style={styles.subHeader}>Scan your barcode to login</Text>
        <Text style={styles.roleHint}>A = Admin · S = Student · T = Teacher</Text>

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => {
            setCameraMode('auth');
            setShowCamera(true);
          }}
        >
          <Text style={styles.btnText}>Scan User Barcode</Text>
        </TouchableOpacity>

        <CameraModal
          visible={showCamera}
          device={device}
          codeScanner={codeScanner}
          hint="Scan your barcode"
          onClose={() => setShowCamera(false)}
        />
      </View>
    );
  }

  // HOME
  if (screen === 'home') {
    const overdueCount = myBorrowedBooks.filter(b => isOverdue(b.status.dueDate)).length;

    return (
      <View style={styles.container}>
        <View style={styles.userBar}>
          <Text style={styles.userText}>
            {currentUser} {isAdmin ? '(Admin)' : currentUser?.startsWith('T') ? '(Teacher)' : '(Student)'}
          </Text>
          <TouchableOpacity onPress={() => { setCurrentUser(null); setScreen('login'); }}>
            <Text style={styles.logout}>Logout</Text>
          </TouchableOpacity>
        </View>

        {!isOnline && (
          <View style={styles.offlineBanner}>
            <Text style={styles.offlineText}>OFFLINE MODE – Borrow/Return disabled</Text>
          </View>
        )}

        <Text style={styles.header}>Welcome</Text>

        <View style={styles.infoCard}>
          <Text style={styles.infoLabel}>Borrowed Books</Text>
          <Text style={styles.infoValue}>{myBorrowedBooks.length}</Text>
          {overdueCount > 0 ? (
            <Text style={styles.overdueText}>{overdueCount} overdue</Text>
          ) : (
            <Text style={{ color: '#2e7d32' }}>No overdue books</Text>
          )}
        </View>

        <TouchableOpacity style={styles.primaryButton} onPress={() => setScreen('scan')}>
          <Text style={styles.btnText}>Scan a Book</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => {
            loadMyBorrowedBooks(currentUser!);
            setScreen('myBooks');
          }}
        >
          <Text style={styles.btnText}>My Borrowed Books</Text>
        </TouchableOpacity>

        {isAdmin && (
          <TouchableOpacity
            style={[styles.secondaryButton, { backgroundColor: '#6a1b9a' }]}
            onPress={() => {
              setAdminSearch('');
              setAdminBook(null);
              setAdminStatus(null);
              setScreen('adminEdit');
            }}
          >
            <Text style={styles.btnText}>Admin: Edit Status</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // SCAN
  if (screen === 'scan') {
    return (
      <View style={styles.container}>
        <Text style={styles.header}>Scan Book</Text>

        <TouchableOpacity
          style={[styles.primaryButton, scanning && styles.disabled]}
          onPress={scanRFID}
          disabled={scanning}
        >
          {scanning ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Scan RFID</Text>}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.secondaryButton, scanning && styles.disabled]}
          onPress={() => {
            setCameraMode('book');
            setShowCamera(true);
          }}
          disabled={scanning}
        >
          <Text style={styles.btnText}>Scan Barcode</Text>
        </TouchableOpacity>

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <TouchableOpacity onPress={() => setScreen('home')}>
          <Text style={styles.link}>← Back</Text>
        </TouchableOpacity>

        <CameraModal
          visible={showCamera}
          device={device}
          codeScanner={codeScanner}
          hint="Scan book barcode"
          onClose={() => setShowCamera(false)}
        />
      </View>
    );
  }

  // BOOK ACTIONS
  if (screen === 'bookActions' && book && statusData) {
    const isBorrowedByMe = statusData.holder === currentUser;
    const isAvailable = statusData.status === 'available';
    const overdue = isOverdue(statusData.dueDate);
    const canReturn = (isBorrowedByMe || isAdmin) && statusData.status === 'checked out';
    const canExtend =
      isBorrowedByMe &&
      !statusData.extended &&
      !overdue &&
      statusData.status === 'checked out' &&
      isOnline;

    return (
      <View style={styles.container}>
        <Text style={styles.header}>{book.title}</Text>
        <Text style={styles.author}>by {book.author}</Text>

        <View style={styles.statusBox}>
          <Text>
            Status:{' '}
            <Text style={{ fontWeight: '700', color: isAvailable ? '#2e7d32' : '#ef6c00' }}>
              {statusData.status.toUpperCase()}
            </Text>
          </Text>
          {statusData.holder !== 'library' && <Text>Holder: {statusData.holder}</Text>}
          {statusData.dueDate && (
            <Text style={{ color: overdue ? '#c62828' : '#333' }}>
              Due: {statusData.dueDate}{overdue ? ' (OVERDUE)' : ''}
            </Text>
          )}
        </View>

        {!isOnline && (
          <Text style={styles.offlineWarning}>Offline – actions disabled</Text>
        )}

        <TouchableOpacity style={styles.secondaryButton} onPress={() => setScreen('bookInfo')}>
          <Text style={styles.btnText}>Book Info</Text>
        </TouchableOpacity>

        {isAvailable && isOnline && (
          <TouchableOpacity style={styles.primaryButton} onPress={borrowBook}>
            <Text style={styles.btnText}>Borrow (2 weeks)</Text>
          </TouchableOpacity>
        )}

        {canReturn && isOnline && (
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: '#2e7d32' }]}
            onPress={returnBook}
          >
            <Text style={styles.btnText}>Return</Text>
          </TouchableOpacity>
        )}

        {canExtend && (
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: '#1565c0' }]}
            onPress={extendBook}
          >
            <Text style={styles.btnText}>Extend (+2 weeks)</Text>
          </TouchableOpacity>
        )}

        {overdue && isBorrowedByMe && (
          <Text style={styles.overdueMessage}>This book is overdue. Please return it.</Text>
        )}

        <TouchableOpacity onPress={() => setScreen('scan')}>
          <Text style={styles.link}>← Scan another</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // BOOK INFO
  if (screen === 'bookInfo' && book) {
    return (
      <View style={styles.container}>
        <Text style={styles.header}>Book Information</Text>
        <ScrollView style={styles.card}>
          <Text style={styles.title}>{book.title}</Text>
          <Text style={styles.author}>by {book.author}</Text>
          <Row label="Barcode" value={book.barcode} />
          <Row label="ISBN" value={book.isbn} />
          <Row label="Call Number" value={book.callNumber} />
          <Row label="Location" value={book.location} />
        </ScrollView>
        <TouchableOpacity style={styles.primaryButton} onPress={() => setScreen('afterAction')}>
          <Text style={styles.btnText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // AFTER ACTION
  if (screen === 'afterAction') {
    return (
      <View style={styles.container}>
        <Text style={styles.header}>What next?</Text>
        <TouchableOpacity style={styles.primaryButton} onPress={() => setScreen('scan')}>
          <Text style={styles.btnText}>Scan Another Book</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => {
            loadMyBorrowedBooks(currentUser!);
            setScreen('myBooks');
          }}
        >
          <Text style={styles.btnText}>My Borrowed Books</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.secondaryButton, { backgroundColor: '#555' }]}
          onPress={() => setScreen('home')}
        >
          <Text style={styles.btnText}>Finish</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // MY BOOKS
  if (screen === 'myBooks') {
    return (
      <View style={styles.container}>
        <Text style={styles.header}>My Borrowed Books</Text>
        {loadingMyBooks ? (
          <ActivityIndicator size="large" color="#0066cc" />
        ) : myBorrowedBooks.length === 0 ? (
          <Text style={{ textAlign: 'center', marginTop: 40 }}>No borrowed books</Text>
        ) : (
          <FlatList
            data={myBorrowedBooks}
            keyExtractor={item => item.book.barcode}
            renderItem={({ item }) => {
              const overdue = isOverdue(item.status.dueDate);
              return (
                <View style={[styles.bookItem, overdue && styles.overdueItem]}>
                  <Text style={styles.bookTitle}>{item.book.title}</Text>
                  <Text>Due: {item.status.dueDate || '—'}</Text>
                  {overdue && <Text style={styles.overdueBadge}>OVERDUE</Text>}
                  <Text>Extended: {item.status.extended ? 'Yes' : 'No'}</Text>
                </View>
              );
            }}
          />
        )}
        <TouchableOpacity style={styles.primaryButton} onPress={() => setScreen('home')}>
          <Text style={styles.btnText}>Back to Home</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ADMIN EDIT
  if (screen === 'adminEdit') {
    return (
      <View style={styles.container}>
        <Text style={styles.header}>Admin – Edit Status</Text>

        <TextInput
          style={styles.input}
          placeholder="Barcode or ISBN"
          value={adminSearch}
          onChangeText={setAdminSearch}
          autoCapitalize="characters"
        />

        <TouchableOpacity style={styles.primaryButton} onPress={adminFindBook}>
          <Text style={styles.btnText}>Find Book</Text>
        </TouchableOpacity>

        {adminBook && adminStatus && (
          <View style={styles.card}>
            <Text style={styles.title}>{adminBook.title}</Text>
            <Text>Barcode: {adminBook.barcode}</Text>
            <Text>ISBN: {adminBook.isbn}</Text>
            <Text>Status: {adminStatus.status}</Text>
            <Text>Holder: {adminStatus.holder}</Text>

            <TouchableOpacity
              style={[styles.secondaryButton, { backgroundColor: '#2e7d32', marginTop: 16 }]}
              onPress={() => adminSetStatus('available')}
            >
              <Text style={styles.btnText}>Set Available</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryButton, { backgroundColor: '#ef6c00' }]}
              onPress={() => adminSetStatus('not available')}
            >
              <Text style={styles.btnText}>Set Not Available</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryButton, { backgroundColor: '#6a1b9a' }]}
              onPress={() => adminSetStatus('missing')}
            >
              <Text style={styles.btnText}>Set Missing</Text>
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity onPress={() => setScreen('home')}>
          <Text style={styles.link}>← Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return null;
}

// ===================== SMALL COMPONENTS =====================
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function CameraModal({
  visible,
  device,
  codeScanner,
  hint,
  onClose,
}: {
  visible: boolean;
  device: any;
  codeScanner: any;
  hint: string;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide">
      <View style={styles.cameraContainer}>
        {device ? (
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={visible}
            codeScanner={codeScanner}
          />
        ) : (
          <Text style={{ color: '#fff', textAlign: 'center', marginTop: 60 }}>
            No camera found
          </Text>
        )}
        <View style={styles.cameraOverlay}>
          <Text style={styles.cameraHint}>{hint}</Text>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.btnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ===================== STYLES =====================
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    padding: 20,
    paddingTop: 50,
  },
  header: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  subHeader: {
    fontSize: 15,
    textAlign: 'center',
    color: '#666',
    marginBottom: 8,
  },
  roleHint: {
    textAlign: 'center',
    color: '#888',
    marginBottom: 24,
    fontSize: 13,
  },
  userBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  userText: { fontSize: 14, color: '#333' },
  logout: { color: '#c62828', fontWeight: '600' },
  offlineBanner: {
    backgroundColor: '#fff3e0',
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  offlineText: { color: '#e65100', textAlign: 'center', fontWeight: '600' },
  offlineWarning: {
    color: '#e65100',
    textAlign: 'center',
    marginBottom: 12,
    fontWeight: '600',
  },
  infoCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    marginBottom: 24,
    elevation: 2,
  },
  infoLabel: { fontSize: 14, color: '#666' },
  infoValue: { fontSize: 32, fontWeight: '700', marginVertical: 4 },
  overdueText: { color: '#c62828', fontWeight: '600' },
  primaryButton: {
    backgroundColor: '#0066cc',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  secondaryButton: {
    backgroundColor: '#2e7d32',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  disabled: { opacity: 0.6 },
  link: { textAlign: 'center', color: '#0066cc', marginTop: 20, fontSize: 16 },
  author: { textAlign: 'center', color: '#555', marginBottom: 16 },
  statusBox: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
  },
  title: { fontSize: 20, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    paddingBottom: 6,
  },
  label: { fontSize: 14, color: '#888' },
  value: { fontSize: 14, fontWeight: '500', maxWidth: '60%', textAlign: 'right' },
  bookItem: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 10,
    marginBottom: 10,
  },
  overdueItem: {
    borderColor: '#c62828',
    borderWidth: 2,
    backgroundColor: '#fff5f5',
  },
  bookTitle: { fontWeight: '700', fontSize: 16, marginBottom: 4 },
  overdueBadge: { color: '#c62828', fontWeight: '700', marginTop: 4 },
  overdueMessage: {
    color: '#c62828',
    textAlign: 'center',
    marginTop: 12,
    fontWeight: '600',
  },
  errorBox: {
    backgroundColor: '#ffebee',
    padding: 12,
    borderRadius: 8,
    marginVertical: 12,
  },
  errorText: { color: '#c62828', textAlign: 'center' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 12,
    backgroundColor: '#fff',
  },
  cameraContainer: { flex: 1, backgroundColor: '#000' },
  cameraOverlay: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  cameraHint: {
    color: '#fff',
    fontSize: 16,
    marginBottom: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  closeBtn: {
    backgroundColor: '#c62828',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 10,
  },
});
